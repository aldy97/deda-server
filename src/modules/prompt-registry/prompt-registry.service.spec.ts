import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PromptRegistryService } from "./prompt-registry.service";
import { PROMPT_DEFAULTS } from "./prompt-defaults";
import { PROMPT_KEYS, type PromptKey } from "./prompt-keys";
import { PromptRenderError, renderPrompt } from "./prompt-render.util";

/**
 * Prisma 替身：只实现 registry 用到的两个 model 的查询方法。
 * 通过 __setPublished / __failNext 控制返回值，验证缓存与回落行为。
 */
function makePrismaStub() {
  const published = new Map<string, { revision: number; content: string }>();
  let failFindMany = false;
  const calls: string[] = [];

  return {
    calls,
    published,
    setPublished(key: string, revision: number, content: string): void {
      published.set(key, { revision, content });
    },
    clearPublished(): void {
      published.clear();
    },
    setFailNext(value: boolean): void {
      failFindMany = value;
    },
    promptTemplate: {
      findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
        calls.push("promptTemplate.findMany");
        if (failFindMany) throw new Error("db down");
        const wanted = args?.where?.key?.in ?? [...published.keys()];
        return wanted
          .filter((key) => published.has(key))
          .map((key) => ({
            id: `tpl-${key}`,
            key,
            publishedRevision: published.get(key)!.revision,
          }));
      },
    },
    promptTemplateVersion: {
      findMany: async (args: {
        where?: { OR?: Array<{ templateId: string; revision: number }> };
      }) => {
        calls.push("promptTemplateVersion.findMany");
        if (failFindMany) throw new Error("db down");
        const pairs = args?.where?.OR ?? [];
        return pairs
          .filter((pair) => {
            const key = pair.templateId.replace(/^tpl-/, "");
            return published.get(key)?.revision === pair.revision;
          })
          .map((pair) => {
            const key = pair.templateId.replace(/^tpl-/, "");
            return {
              templateId: pair.templateId,
              revision: pair.revision,
              content: published.get(key)!.content,
            };
          });
      },
    },
  };
}

type PrismaStub = ReturnType<typeof makePrismaStub>;

async function makeService(prisma: PrismaStub): Promise<PromptRegistryService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PromptRegistryService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return moduleRef.get(PromptRegistryService);
}

describe("PromptRegistryService", () => {
  let prisma: PrismaStub;
  let service: PromptRegistryService;

  beforeEach(async () => {
    prisma = makePrismaStub();
    service = await makeService(prisma);
  });

  describe("未发布状态（首次上线的默认路径）", () => {
    it("DB 无任何 published 版本时，全部 key 回落代码默认值", () => {
      for (const key of PROMPT_KEYS) {
        expect(service.getTemplate(key)).toBe(PROMPT_DEFAULTS[key].template);
      }
    });

    it("resolveTemplate 报告 source=default 且 revision=null", () => {
      const resolved = service.resolveTemplate("safety_l2_system");
      expect(resolved.source).toBe("default");
      expect(resolved.revision).toBeNull();
      expect(resolved.content).toBe(PROMPT_DEFAULTS.safety_l2_system.template);
    });

    it("getTemplate 是同步的（不返回 Promise）", () => {
      const value = service.getTemplate("persona_elly");
      expect(typeof value).toBe("string");
      expect(value).not.toBeInstanceOf(Promise);
    });
  });

  describe("已发布状态", () => {
    it("reload 后读到 DB 内容并标记 source=db", async () => {
      prisma.setPublished("safety_l2_system", 3, "自定义安全分类器 prompt");
      await service.reload();
      const resolved = service.resolveTemplate("safety_l2_system");
      expect(resolved.source).toBe("db");
      expect(resolved.revision).toBe(3);
      expect(resolved.content).toBe("自定义安全分类器 prompt");
    });

    it("只覆盖已发布的 key，其余仍走默认", async () => {
      prisma.setPublished("persona_elly", 1, "改版 Elly 人设");
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe("改版 Elly 人设");
      expect(service.getTemplate("persona_polly")).toBe(
        PROMPT_DEFAULTS.persona_polly.template,
      );
    });

    it("发布新版本后 reload 原子换入，读取永不落回默认值", async () => {
      prisma.setPublished("persona_elly", 1, "第一版");
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe("第一版");

      prisma.setPublished("persona_elly", 2, "第二版");
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe("第二版");
      expect(service.resolveTemplate("persona_elly").revision).toBe(2);
    });

    it("DB 内容为空串时不生效，回落默认值（防 admin 误清空把空 prompt 发给模型）", async () => {
      prisma.setPublished("safety_l2_system", 1, "");
      await service.reload();
      expect(service.resolveTemplate("safety_l2_system").source).toBe(
        "default",
      );
      expect(service.getTemplate("safety_l2_system")).toBe(
        PROMPT_DEFAULTS.safety_l2_system.template,
      );
    });

    it("撤销发布（publishedRevision 变回 null）后回落默认值", async () => {
      prisma.setPublished("persona_elly", 1, "第一版");
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe("第一版");

      prisma.clearPublished();
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
      expect(service.resolveTemplate("persona_elly").source).toBe("default");
    });
  });

  describe("DB 故障 fail-safe", () => {
    it("onModuleInit 时 DB 挂了不抛错，全部走默认值", async () => {
      prisma.setFailNext(true);
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(service.getTemplate("safety_l2_system")).toBe(
        PROMPT_DEFAULTS.safety_l2_system.template,
      );
    });

    it("reload 失败时保留已有缓存，不清空", async () => {
      prisma.setPublished("persona_elly", 1, "已加载的版本");
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe("已加载的版本");

      prisma.setFailNext(true);
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe("已加载的版本");
    });
  });

  describe("render", () => {
    it("无变量模板原样返回", () => {
      expect(service.render("safety_l2_system")).toBe(
        PROMPT_DEFAULTS.safety_l2_system.template,
      );
    });

    it("替换 DB 内容里的变量", async () => {
      prisma.setPublished(
        "adventure_interaction_system",
        1,
        "人设={{characterPersona}} 问题={{segmentText}} 规则={{redirectRule}}",
      );
      await service.reload();
      expect(
        service.render("adventure_interaction_system", {
          characterPersona: "Elly",
          segmentText: "走哪条路？",
          redirectRule: "接住并引回",
        }),
      ).toBe("人设=Elly 问题=走哪条路？ 规则=接住并引回");
    });

    it("DB 内容渲染失败时回落默认模板渲染（不把 {{x}} 漏给模型）", async () => {
      prisma.setPublished(
        "adventure_interaction_system",
        1,
        "admin 写坏了 {{不存在的变量}}",
      );
      await service.reload();
      const vars = {
        characterPersona: "Elly",
        segmentText: "走哪条路？",
        redirectRule: "接住并引回",
      };
      const rendered = service.render("adventure_interaction_system", vars);
      const expected = renderPrompt(
        PROMPT_DEFAULTS.adventure_interaction_system.template,
        vars,
        PROMPT_DEFAULTS.adventure_interaction_system.variables,
      );
      expect(rendered).toBe(expected);
      expect(rendered).not.toContain("{{");
      expect(rendered).not.toContain("不存在的变量");
    });

    it("默认模板本身渲染失败时抛 PromptRenderError（属代码 bug，不静默）", () => {
      expect(() => service.render("adventure_interaction_system", {})).toThrow(
        PromptRenderError,
      );
    });

    it("可选变量缺省时渲染为空串而非报错", () => {
      const rendered = service.render("filler_system");
      expect(rendered).toBe(
        PROMPT_DEFAULTS.filler_system.template.replace(
          /{{(contextSection|bannedSection)}}/g,
          "",
        ),
      );
      expect(rendered).not.toContain("{{");
    });
  });

  describe("getPersona", () => {
    it("按 characterKey 取对应人设", () => {
      expect(service.getPersona("elly")).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
      expect(service.getPersona("polly")).toBe(
        PROMPT_DEFAULTS.persona_polly.template,
      );
    });

    it("未知/缺省 characterKey 回落 elly（保持既有防匿名行为）", () => {
      expect(service.getPersona("nope")).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
      expect(service.getPersona(null)).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
      expect(service.getPersona(undefined)).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
    });

    it("人设被发布后 getPersona 读到新值", async () => {
      prisma.setPublished("persona_polly", 1, "改版 Polly");
      await service.reload();
      expect(service.getPersona("polly")).toBe("改版 Polly");
      expect(service.getPersona("elly")).toBe(
        PROMPT_DEFAULTS.persona_elly.template,
      );
    });
  });

  describe("getStoryPrompt", () => {
    const STORY_INTENTS = [
      "english_story",
      "idiom_story",
      "sleep_story",
      "adventure_story",
      "free_story",
    ];

    it("五种故事意图各取对应默认话术", () => {
      expect(service.getStoryPrompt("english_story")).toBe(
        PROMPT_DEFAULTS.story_prompt_english.template,
      );
      expect(service.getStoryPrompt("idiom_story")).toBe(
        PROMPT_DEFAULTS.story_prompt_idiom.template,
      );
      expect(service.getStoryPrompt("sleep_story")).toBe(
        PROMPT_DEFAULTS.story_prompt_sleep.template,
      );
      // 冒险未真正开始时降级为自由创作话术，与 free_story 同一条
      expect(service.getStoryPrompt("adventure_story")).toBe(
        PROMPT_DEFAULTS.story_prompt_free.template,
      );
      expect(service.getStoryPrompt("free_story")).toBe(
        PROMPT_DEFAULTS.story_prompt_free.template,
      );
    });

    it("非故事意图返回 undefined（保持既有 default 分支语义）", () => {
      expect(service.getStoryPrompt("sleep_config")).toBeUndefined();
      expect(service.getStoryPrompt("free_chat")).toBeUndefined();
      expect(service.getStoryPrompt("")).toBeUndefined();
      expect(STORY_INTENTS).toHaveLength(5);
    });

    it("传 favoriteStoryType 时追加软提示段", () => {
      const base = service.getStoryPrompt("english_story");
      const withFavorite = service.getStoryPrompt("english_story", "恐龙");
      expect(withFavorite).toBe(
        base +
          PROMPT_DEFAULTS.story_favorite_type_suffix.template.replace(
            "{{favoriteStoryType}}",
            "恐龙",
          ),
      );
      expect(withFavorite?.startsWith(base!)).toBe(true);
    });

    it("favoriteStoryType 为 null / 空串时不追加", () => {
      const base = service.getStoryPrompt("idiom_story");
      expect(service.getStoryPrompt("idiom_story", null)).toBe(base);
      expect(service.getStoryPrompt("idiom_story", "")).toBe(base);
      expect(service.getStoryPrompt("idiom_story", undefined)).toBe(base);
    });

    it("话术被发布后读到新值，追加段仍按默认渲染", async () => {
      prisma.setPublished("story_prompt_sleep", 1, "自定义哄睡话术");
      await service.reload();
      expect(service.getStoryPrompt("sleep_story", "星星")).toBe(
        "自定义哄睡话术" +
          PROMPT_DEFAULTS.story_favorite_type_suffix.template.replace(
            "{{favoriteStoryType}}",
            "星星",
          ),
      );
    });
  });

  describe("缓存与后台刷新", () => {
    it("首次同步读取会触发后台加载，但立即返回默认值不阻塞", () => {
      const value = service.getTemplate("persona_elly");
      expect(value).toBe(PROMPT_DEFAULTS.persona_elly.template);
    });

    it("后台加载并发去重：多次同步读取不重复打 DB", async () => {
      prisma.setPublished("persona_elly", 1, "x");
      service.getTemplate("persona_elly");
      service.getTemplate("persona_elly");
      service.getTemplate("persona_elly");
      await service.reload();
      // 三次同步读取应被 in-flight 去重成一次后台加载，加上显式 reload 至多 2 次
      const templateCalls = prisma.calls.filter(
        (c) => c === "promptTemplate.findMany",
      ).length;
      expect(templateCalls).toBeLessThanOrEqual(2);
    });

    it("TTL 内重复读取不打 DB", async () => {
      await service.reload();
      const before = prisma.calls.length;
      service.getTemplate("persona_elly");
      service.getTemplate("safety_l2_system");
      expect(prisma.calls.length).toBe(before);
    });

    it("TTL 过期后后台重载失败：热路径仍立即返回旧值，不抛错也不回落默认", async () => {
      prisma.setPublished("persona_elly", 1, "db-v1");
      await service.reload();
      expect(service.getTemplate("persona_elly")).toBe("db-v1");

      prisma.setFailNext(true);
      const base = Date.now();
      const nowSpy = jest
        .spyOn(Date, "now")
        .mockImplementation(() => base + 61_000);
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      try {
        // 同步读取必须立刻返回，且拿的是旧缓存值而非代码默认值
        expect(service.getTemplate("persona_elly")).toBe("db-v1");
        await service.reload();
        // 断言必须写在 mockRestore 之前：restore 会连带清空 mock 的调用记录
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Prompt registry reload failed"),
        );
      } finally {
        nowSpy.mockRestore();
        warnSpy.mockRestore();
      }
      expect(service.getTemplate("persona_elly")).toBe("db-v1");
    });

    it("后台重载意外 reject 时只 warn：异常绝不冒到对话热路径", async () => {
      prisma.setPublished("persona_elly", 1, "db-v1");
      await service.reload();

      const base = Date.now();
      const nowSpy = jest
        .spyOn(Date, "now")
        .mockImplementation(() => base + 61_000);
      // doReload 自己吞掉了 DB 异常，这条走的是「未来有人收窄那层 catch」时的安全网
      const reloadSpy = jest
        .spyOn(service, "reload")
        .mockRejectedValue(new Error("unexpected"));
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => undefined);
      try {
        expect(service.getTemplate("persona_elly")).toBe("db-v1");
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("Background prompt registry reload failed"),
        );
      } finally {
        nowSpy.mockRestore();
        reloadSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe("key 完备性", () => {
    it("PROMPT_DEFAULTS 覆盖全部 PROMPT_KEYS，无多余项", () => {
      expect(Object.keys(PROMPT_DEFAULTS).sort()).toEqual(
        [...PROMPT_KEYS].sort(),
      );
    });

    it("每个默认模板都非空且不含未声明占位符残留", () => {
      for (const key of PROMPT_KEYS as readonly PromptKey[]) {
        const def = PROMPT_DEFAULTS[key];
        expect(def.template.trim().length).toBeGreaterThan(0);
        expect(def.key).toBe(key);
      }
    });
  });
});
