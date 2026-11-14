import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PROMPT_DEFAULTS } from "@/modules/prompt-registry/prompt-defaults";
import {
  PROMPT_KEYS,
  type PromptKey,
} from "@/modules/prompt-registry/prompt-keys";
import type { PromptRegistryService } from "@/modules/prompt-registry/prompt-registry.service";
import { PromptAdminService, type PromptAuthor } from "./prompt-admin.service";

/**
 * 内存版 prisma 替身：只实现 PromptAdminService 用到的查询形状。
 * 用真实数据结构而非 jest.fn 逐个 mock，这样乐观锁、事务、单调递增版本号
 * 这些跨多条查询的不变量才测得出来。
 */
interface TemplateRow {
  id: string;
  key: string;
  category: string;
  scene: string | null;
  name: string;
  description: string | null;
  renderSchema: Prisma.JsonValue | null;
  draftRevision: number | null;
  publishedRevision: number | null;
  publishedAt: Date | null;
  publishedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface VersionRow {
  id: string;
  templateId: string;
  revision: number;
  content: string;
  changeNote: string | null;
  authorUsername: string;
  authorDisplayName: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

function makePrismaFake() {
  const templates: TemplateRow[] = [];
  const versions: VersionRow[] = [];
  let seq = 0;
  const nextId = (): string => `id-${++seq}`;
  const now = (): Date => new Date("2026-11-13T00:00:00.000Z");

  const duplicateKey = (): never => {
    throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
  };

  const tx = {
    promptTemplate: {
      findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
        const wanted = args?.where?.key?.in;
        return wanted
          ? templates.filter((t) => wanted.includes(t.key))
          : [...templates];
      },
      findUnique: async (args: { where: { key?: string; id?: string } }) => {
        const { key, id } = args.where;
        return (
          templates.find((t) => (key ? t.key === key : t.id === id)) ?? null
        );
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const data = args.data as unknown as TemplateRow;
        if (templates.some((t) => t.key === data.key)) duplicateKey();
        const row: TemplateRow = {
          renderSchema: null,
          scene: null,
          description: null,
          draftRevision: null,
          publishedRevision: null,
          publishedAt: null,
          publishedBy: null,
          createdAt: now(),
          updatedAt: now(),
          ...data,
          id: data.id ?? nextId(),
        };
        templates.push(row);
        return row;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = templates.find((t) => t.id === args.where.id);
        if (!row) throw new Error("template not found");
        Object.assign(row, args.data, { updatedAt: now() });
        return row;
      },
    },
    promptTemplateVersion: {
      findMany: async (args: {
        where: { templateId: string };
        orderBy?: { revision: "desc" | "asc" };
      }) => {
        const rows = versions.filter(
          (v) => v.templateId === args.where.templateId,
        );
        return args.orderBy?.revision === "desc"
          ? [...rows].sort((a, b) => b.revision - a.revision)
          : rows;
      },
      findFirst: async (args: {
        where: { templateId: string };
        orderBy?: { revision: "desc" | "asc" };
      }) => {
        const rows = versions.filter(
          (v) => v.templateId === args.where.templateId,
        );
        if (rows.length === 0) return null;
        return args.orderBy?.revision === "desc"
          ? [...rows].sort((a, b) => b.revision - a.revision)[0]
          : rows[0];
      },
      findUnique: async (args: {
        where: {
          templateId_revision: { templateId: string; revision: number };
        };
      }) => {
        const { templateId, revision } = args.where.templateId_revision;
        return (
          versions.find(
            (v) => v.templateId === templateId && v.revision === revision,
          ) ?? null
        );
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const data = args.data as unknown as VersionRow;
        if (
          versions.some(
            (v) =>
              v.templateId === data.templateId && v.revision === data.revision,
          )
        ) {
          duplicateKey();
        }
        const row: VersionRow = {
          changeNote: null,
          authorDisplayName: null,
          publishedAt: null,
          createdAt: now(),
          ...data,
          id: data.id ?? nextId(),
        };
        versions.push(row);
        return row;
      },
      update: async (args: {
        where: {
          templateId_revision: { templateId: string; revision: number };
        };
        data: Record<string, unknown>;
      }) => {
        const { templateId, revision } = args.where.templateId_revision;
        const row = versions.find(
          (v) => v.templateId === templateId && v.revision === revision,
        );
        if (!row) throw new Error("version not found");
        Object.assign(row, args.data);
        return row;
      },
    },
  };

  return {
    ...tx,
    templates,
    versions,
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> =>
      fn(tx),
    /**
     * 测试辅助：模拟两个 admin 同时首次建行——对手事务已把行插进去，
     * 我方 create 随即撞唯一键（P2002），服务应重读而不是冒 500。
     */
    failNextCreateOnce(): void {
      const original = tx.promptTemplate.create;
      let armed = true;
      tx.promptTemplate.create = async (args) => {
        const row = await original(args);
        if (armed) {
          armed = false;
          tx.promptTemplate.create = original;
          duplicateKey();
        }
        return row;
      };
    },
  };
}

type PrismaFake = ReturnType<typeof makePrismaFake>;

/** registry 替身：effective 内容跟随 fake DB 的 published 版本，并记录 invalidate */
function makeRegistryFake(prisma: PrismaFake) {
  const reload = jest.fn(async () => undefined);
  const resolveTemplate = (key: PromptKey) => {
    const template = prisma.templates.find((t) => t.key === key);
    if (template?.publishedRevision != null) {
      const version = prisma.versions.find(
        (v) =>
          v.templateId === template.id &&
          v.revision === template.publishedRevision,
      );
      if (version) {
        return {
          content: version.content,
          revision: version.revision,
          source: "db" as const,
        };
      }
    }
    return {
      content: PROMPT_DEFAULTS[key].template,
      revision: null,
      source: "default" as const,
    };
  };
  return {
    reload,
    resolveTemplate,
    getTemplate: (key: PromptKey) => resolveTemplate(key).content,
  } as unknown as PromptRegistryService & { reload: jest.Mock };
}

const AUTHOR: PromptAuthor = { username: "admin", displayName: "管理员" };

function makeService(env: Record<string, string> = {}) {
  const prisma = makePrismaFake();
  const registry = makeRegistryFake(prisma);
  const configService = { get: (key: string) => env[key] };
  const service = new PromptAdminService(
    prisma as unknown as PrismaService,
    registry,
    configService as never,
  );
  return { service, prisma, registry };
}

describe("PromptAdminService", () => {
  describe("getWritePolicy / 环境元信息", () => {
    it("缺省：写开启，确认码 DEDA2025", () => {
      const { service } = makeService();
      expect(service.getWritePolicy()).toEqual({
        promptWriteEnabled: true,
        publishConfirmCode: "DEDA2025",
      });
    });

    it("env 覆盖确认码与写开关", () => {
      const { service } = makeService({
        PROMPT_PUBLISH_CONFIRM_CODE: "OTHER-9",
        PROMPT_WRITE_ENABLED: "false",
      });
      expect(service.getWritePolicy()).toEqual({
        promptWriteEnabled: false,
        publishConfirmCode: "OTHER-9",
      });
    });

    it("PROMPT_WRITE_ENABLED 只有字面 false 才关写（避免打错字静默禁写）", () => {
      expect(
        makeService({ PROMPT_WRITE_ENABLED: "0" }).service.isWriteEnabled(),
      ).toBe(true);
      expect(
        makeService({ PROMPT_WRITE_ENABLED: "FALSE" }).service.isWriteEnabled(),
      ).toBe(false);
    });
  });

  describe("list / get", () => {
    it("DB 为空时返回全部 key，一律 source=default 且未偏离默认", async () => {
      const { service } = makeService();
      const items = await service.list();
      expect(items).toHaveLength(PROMPT_KEYS.length);
      expect(items.map((i) => i.key).sort()).toEqual([...PROMPT_KEYS].sort());
      for (const item of items) {
        expect(item.source).toBe("default");
        expect(item.publishedRevision).toBeNull();
        expect(item.draftRevision).toBeNull();
        expect(item.deviatesFromDefault).toBe(false);
        expect(item.effectiveContent).toBe(PROMPT_DEFAULTS[item.key].template);
        expect(item.defaultContent).toBe(PROMPT_DEFAULTS[item.key].template);
      }
    });

    it("catalog 带上分类、展示名与变量契约（dashboard 据此渲染表单）", async () => {
      const { service } = makeService();
      const item = (await service.list()).find(
        (i) => i.key === "adventure_interaction_system",
      );
      expect(item?.category).toBe("small_model");
      expect(item?.name.length).toBeGreaterThan(0);
      expect(item?.variables.map((v) => v.name).sort()).toEqual([
        "characterPersona",
        "redirectRule",
        "segmentText",
      ]);
    });

    it("已发布的 key 标记 source=db 且 deviatesFromDefault=true", async () => {
      const { service, prisma } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "改版人设", expectedRevision: 0 },
        AUTHOR,
      );
      await service.publish(
        "persona_elly",
        { revision: 1, changeNote: "首次改版", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      const item = (await service.list()).find((i) => i.key === "persona_elly");
      expect(item?.source).toBe("db");
      expect(item?.publishedRevision).toBe(1);
      expect(item?.deviatesFromDefault).toBe(true);
      expect(item?.publishedBy).toBe("admin");
      expect(prisma.versions[0].publishedAt).not.toBeNull();
    });

    it("get 返回详情：草稿正文与已发布正文分开给", async () => {
      const { service } = makeService();
      await service.saveDraft(
        "persona_polly",
        { content: "草稿正文", expectedRevision: 0 },
        AUTHOR,
      );
      const detail = await service.get("persona_polly");
      expect(detail.draftRevision).toBe(1);
      expect(detail.draftContent).toBe("草稿正文");
      expect(detail.publishedRevision).toBeNull();
      expect(detail.publishedContent).toBeNull();
      expect(detail.defaultContent).toBe(
        PROMPT_DEFAULTS.persona_polly.template,
      );
    });

    it("get 未知 key → 404（不静默建出一个代码不认的模板）", async () => {
      const { service } = makeService();
      await expect(service.get("not_a_key" as PromptKey)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("saveDraft：乐观锁与惰性建行", () => {
    it("首次保存才建 template 行（启动不 seed，代码即 catalog）", async () => {
      const { service, prisma } = makeService();
      expect(prisma.templates).toHaveLength(0);
      await service.saveDraft(
        "safety_l2_system",
        { content: "新分类器", expectedRevision: 0 },
        AUTHOR,
      );
      expect(prisma.templates).toHaveLength(1);
      expect(prisma.templates[0].key).toBe("safety_l2_system");
      expect(prisma.templates[0].category).toBe("small_model");
      expect(prisma.templates[0].draftRevision).toBe(1);
      expect(prisma.templates[0].publishedRevision).toBeNull();
      expect(prisma.versions).toHaveLength(1);
      expect(prisma.versions[0].content).toBe("新分类器");
      expect(prisma.versions[0].authorUsername).toBe("admin");
      expect(prisma.versions[0].authorDisplayName).toBe("管理员");
      expect(prisma.versions[0].publishedAt).toBeNull();
    });

    it("expectedRevision 不匹配 → 409，且不写库", async () => {
      const { service, prisma } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "A", expectedRevision: 0 },
        AUTHOR,
      );
      const before = prisma.versions[0].content;
      await expect(
        service.saveDraft(
          "persona_elly",
          { content: "B", expectedRevision: 0 },
          AUTHOR,
        ),
      ).rejects.toThrow(ConflictException);
      expect(prisma.versions[0].content).toBe(before);
      expect(prisma.versions).toHaveLength(1);
    });

    it("二次保存同一草稿：就地更新，不新增版本号", async () => {
      const { service, prisma } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "A", expectedRevision: 0 },
        AUTHOR,
      );
      await service.saveDraft(
        "persona_elly",
        { content: "B", expectedRevision: 1, changeNote: "再改一版" },
        AUTHOR,
      );
      expect(prisma.versions).toHaveLength(1);
      expect(prisma.versions[0].content).toBe("B");
      expect(prisma.versions[0].changeNote).toBe("再改一版");
      expect(prisma.templates[0].draftRevision).toBe(1);
    });

    it("已发布后再编辑：草稿版本号 = max+1，生效版本不受影响", async () => {
      const { service, prisma, registry } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "已发布版", expectedRevision: 0 },
        AUTHOR,
      );
      await service.publish(
        "persona_elly",
        { revision: 1, changeNote: "上线", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      await service.saveDraft(
        "persona_elly",
        { content: "新草稿", expectedRevision: 0 },
        AUTHOR,
      );
      expect(prisma.versions).toHaveLength(2);
      expect(prisma.templates[0].draftRevision).toBe(2);
      expect(prisma.templates[0].publishedRevision).toBe(1);
      expect(registry.getTemplate("persona_elly")).toBe("已发布版");
    });

    it("保存草稿不触发 registry 失效（还没生效，不该打扰线上缓存）", async () => {
      const { service, registry } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "A", expectedRevision: 0 },
        AUTHOR,
      );
      expect(registry.reload).not.toHaveBeenCalled();
    });

    it("并发首次建行撞唯一键时重试读取，不冒 500", async () => {
      const { service, prisma } = makeService();
      prisma.failNextCreateOnce();
      const detail = await service.saveDraft(
        "persona_elly",
        { content: "A", expectedRevision: 0 },
        AUTHOR,
      );
      expect(detail.draftRevision).toBe(1);
      expect(prisma.templates).toHaveLength(1);
    });

    it("写开关关闭时拒绝保存", async () => {
      const { service } = makeService({ PROMPT_WRITE_ENABLED: "false" });
      await expect(
        service.saveDraft(
          "persona_elly",
          { content: "A", expectedRevision: 0 },
          AUTHOR,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("publish：确认码服务端校验", () => {
    async function withDraft(content = "待发布正文") {
      const ctx = makeService();
      await ctx.service.saveDraft(
        "persona_elly",
        { content, expectedRevision: 0 },
        AUTHOR,
      );
      return ctx;
    }

    it("发布成功后：版本 publishedAt 落库、指针切换、草稿清空、缓存失效", async () => {
      const { service, prisma, registry } = await withDraft();
      const detail = await service.publish(
        "persona_elly",
        { revision: 1, changeNote: "上线新人设", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      expect(detail.publishedRevision).toBe(1);
      expect(detail.draftRevision).toBeNull();
      expect(detail.source).toBe("db");
      expect(prisma.versions[0].publishedAt).not.toBeNull();
      expect(prisma.versions[0].changeNote).toBe("上线新人设");
      expect(prisma.templates[0].publishedBy).toBe("admin");
      expect(registry.reload).toHaveBeenCalledTimes(1);
    });

    it("确认码错误 → 400，DB 与缓存都不动", async () => {
      const { service, prisma, registry } = await withDraft();
      await expect(
        service.publish(
          "persona_elly",
          { revision: 1, changeNote: "上线", confirmCode: "错了吗" },
          AUTHOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.templates[0].publishedRevision).toBeNull();
      expect(prisma.versions[0].publishedAt).toBeNull();
      expect(registry.reload).not.toHaveBeenCalled();
    });

    it("确认码大小写/空格不容错：必须逐字节相等", async () => {
      const { service } = await withDraft();
      await expect(
        service.publish(
          "persona_elly",
          { revision: 1, changeNote: "上线", confirmCode: "deda2025" },
          AUTHOR,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.publish(
          "persona_elly",
          { revision: 1, changeNote: "上线", confirmCode: " DEDA2025" },
          AUTHOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("revision 与当前草稿不符 → 409（别人已经改过了）", async () => {
      const { service } = await withDraft();
      await expect(
        service.publish(
          "persona_elly",
          { revision: 99, changeNote: "上线", confirmCode: "DEDA2025" },
          AUTHOR,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it("无草稿直接发布 → 409", async () => {
      const { service } = makeService();
      await expect(
        service.publish(
          "persona_elly",
          { revision: 1, changeNote: "上线", confirmCode: "DEDA2025" },
          AUTHOR,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it("env 改了确认码后，旧码不再可用", async () => {
      const prisma = makePrismaFake();
      const registry = makeRegistryFake(prisma);
      const service = new PromptAdminService(
        prisma as unknown as PrismaService,
        registry,
        {
          get: (k: string) =>
            k === "PROMPT_PUBLISH_CONFIRM_CODE" ? "NEW-1" : undefined,
        } as never,
      );
      await service.saveDraft(
        "persona_elly",
        { content: "A", expectedRevision: 0 },
        AUTHOR,
      );
      await expect(
        service.publish(
          "persona_elly",
          { revision: 1, changeNote: "上线", confirmCode: "DEDA2025" },
          AUTHOR,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.publish(
          "persona_elly",
          { revision: 1, changeNote: "上线", confirmCode: "NEW-1" },
          AUTHOR,
        ),
      ).resolves.toMatchObject({ publishedRevision: 1 });
    });
  });

  describe("rollback：git revert 语义", () => {
    async function publishedTwice() {
      const ctx = makeService();
      const { service } = ctx;
      await service.saveDraft(
        "persona_elly",
        { content: "第一版", expectedRevision: 0 },
        AUTHOR,
      );
      await service.publish(
        "persona_elly",
        { revision: 1, changeNote: "上线 v1", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      await service.saveDraft(
        "persona_elly",
        { content: "第二版", expectedRevision: 0 },
        AUTHOR,
      );
      await service.publish(
        "persona_elly",
        { revision: 2, changeNote: "上线 v2", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      return ctx;
    }

    it("以目标版本正文新建 revision 并直接发布，历史版本不被改写", async () => {
      const { service, prisma, registry } = await publishedTwice();
      const detail = await service.rollback(
        "persona_elly",
        { targetRevision: 1, changeNote: "v2 出问题", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      expect(detail.publishedRevision).toBe(3);
      expect(prisma.versions).toHaveLength(3);
      expect(prisma.versions[2].content).toBe("第一版");
      expect(prisma.versions[2].publishedAt).not.toBeNull();
      expect(prisma.versions[2].changeNote).toContain("v2 出问题");
      expect(prisma.versions[2].changeNote).toContain("1");
      // 历史不可变
      expect(prisma.versions[0].content).toBe("第一版");
      expect(prisma.versions[1].content).toBe("第二版");
      expect(registry.getTemplate("persona_elly")).toBe("第一版");
      expect(registry.reload).toHaveBeenCalled();
    });

    it("目标版本不存在 → 404", async () => {
      const { service } = await publishedTwice();
      await expect(
        service.rollback(
          "persona_elly",
          { targetRevision: 42, changeNote: "x", confirmCode: "DEDA2025" },
          AUTHOR,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("从未发布过 → 404（没有可回滚的目标，应改用恢复默认值）", async () => {
      const { service } = makeService();
      await expect(
        service.rollback(
          "persona_elly",
          { targetRevision: 1, changeNote: "x", confirmCode: "DEDA2025" },
          AUTHOR,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("回滚会清掉未发布草稿，并在结果里报告被丢弃的草稿号（内容仍留在版本表）", async () => {
      const { service, prisma } = await publishedTwice();
      await service.saveDraft(
        "persona_elly",
        { content: "在写的草稿", expectedRevision: 0 },
        AUTHOR,
      );
      const detail = await service.rollback(
        "persona_elly",
        { targetRevision: 1, changeNote: "紧急回滚", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      expect(detail.draftRevision).toBeNull();
      expect(detail.discardedDraftRevision).toBe(3);
      expect(prisma.versions.some((v) => v.content === "在写的草稿")).toBe(
        true,
      );
    });

    it("确认码错误 → 400，不产生新版本", async () => {
      const { service, prisma } = await publishedTwice();
      await expect(
        service.rollback(
          "persona_elly",
          { targetRevision: 1, changeNote: "x", confirmCode: "nope" },
          AUTHOR,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.versions).toHaveLength(2);
    });
  });

  describe("resetToDefault：以代码默认值新建版本", () => {
    it("恢复默认后生效正文等于代码默认值，且留下审计版本", async () => {
      const { service, prisma, registry } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "被改坏的版本", expectedRevision: 0 },
        AUTHOR,
      );
      await service.publish(
        "persona_elly",
        { revision: 1, changeNote: "上线", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      const detail = await service.resetToDefault(
        "persona_elly",
        { changeNote: "改坏了，先回默认", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      expect(detail.publishedRevision).toBe(2);
      expect(detail.effectiveContent).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
      expect(prisma.versions).toHaveLength(2);
      expect(prisma.versions[1].content).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
      expect(prisma.versions[1].publishedAt).not.toBeNull();
      expect(registry.reload).toHaveBeenCalled();
    });

    it("从未编辑过的 key 也能恢复默认（惰性建行 + 建首个版本）", async () => {
      const { service, prisma } = makeService();
      const detail = await service.resetToDefault(
        "safety_l2_system",
        { changeNote: "显式钉住默认值", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      expect(detail.publishedRevision).toBe(1);
      expect(prisma.versions[0].content).toBe(
        PROMPT_DEFAULTS.safety_l2_system.template,
      );
    });

    it("确认码错误 → 400", async () => {
      const { service } = makeService();
      await expect(
        service.resetToDefault(
          "safety_l2_system",
          { changeNote: "x", confirmCode: "wrong" },
          AUTHOR,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("listVersions：审计链", () => {
    it("按版本号倒序，并标记哪个是生效版、哪个是草稿", async () => {
      const { service } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "v1", expectedRevision: 0 },
        AUTHOR,
      );
      await service.publish(
        "persona_elly",
        { revision: 1, changeNote: "上线 v1", confirmCode: "DEDA2025" },
        AUTHOR,
      );
      await service.saveDraft(
        "persona_elly",
        { content: "v2 草稿", expectedRevision: 0 },
        AUTHOR,
      );
      const versions = await service.listVersions("persona_elly");
      expect(versions.map((v) => v.revision)).toEqual([2, 1]);
      expect(versions[0]).toMatchObject({
        content: "v2 草稿",
        isDraft: true,
        isPublished: false,
        publishedAt: null,
      });
      expect(versions[1]).toMatchObject({
        content: "v1",
        isDraft: false,
        isPublished: true,
        changeNote: "上线 v1",
        authorUsername: "admin",
      });
      expect(versions[1].publishedAt).not.toBeNull();
      expect(typeof versions[1].createdAt).toBe("string");
    });

    it("从未编辑过的 key 返回空数组而不是 404（catalog 恒在）", async () => {
      const { service } = makeService();
      await expect(service.listVersions("persona_polly")).resolves.toEqual([]);
    });
  });

  describe("故障路径", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("发布已落库后注册表刷新失败：不回滚发布结果，只记 error", async () => {
      const { service, registry } = makeService();
      await service.saveDraft(
        "persona_elly",
        { content: "新人设", expectedRevision: 0 },
        AUTHOR,
      );

      registry.reload.mockRejectedValueOnce(new Error("cache refresh down"));
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);

      const detail = await service.publish(
        "persona_elly",
        { revision: 1, changeNote: "上线", confirmCode: "DEDA2025" },
        AUTHOR,
      );

      // DB 是真相：缓存刷不动也不能把已发布的版本回退掉，最长 TTL 后自愈
      expect(detail.publishedRevision).toBe(1);
      expect(detail.source).toBe("db");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Prompt registry refresh after publish of "persona_elly" failed',
        ),
      );
      await expect(service.listVersions("persona_elly")).resolves.toMatchObject(
        [expect.objectContaining({ revision: 1, isPublished: true })],
      );
    });

    it("惰性建行撞上非唯一键错误时原样抛出（只有 P2002 才重读收敛）", async () => {
      const { service, prisma } = makeService();
      const original = prisma.promptTemplate.create;
      prisma.promptTemplate.create = async () => {
        throw new Error("connection terminated");
      };

      await expect(
        service.saveDraft(
          "persona_elly",
          { content: "新人设", expectedRevision: 0 },
          AUTHOR,
        ),
      ).rejects.toThrow("connection terminated");

      prisma.promptTemplate.create = original;
    });
  });
});
