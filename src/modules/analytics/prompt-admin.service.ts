import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import type { PromptTemplate } from "@prisma/client";
import { timingSafeEqual } from "crypto";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  PROMPT_CONTENT_MAX_CHARS,
  PROMPT_DEFAULTS,
} from "@/modules/prompt-registry/prompt-defaults";
import {
  characterKeyFromPersonaKey,
  isBuiltinPromptKey,
  personaKeyFor,
  PROMPT_KEYS,
  type PromptCategory,
  type PromptKey,
  type PromptVariableSpec,
} from "@/modules/prompt-registry/prompt-keys";
import {
  PromptRegistryService,
  type PromptSource,
} from "@/modules/prompt-registry/prompt-registry.service";
import { findPlaceholders } from "@/modules/prompt-registry/prompt-render.util";
import type { LlmScene } from "@/modules/llm/llm.service";
import type {
  PublishPromptDto,
  ResetPromptToDefaultDto,
  RollbackPromptDto,
  SavePromptDraftDto,
} from "./dto/prompt-admin.dto";

/** 确认码默认值；可用 env PROMPT_PUBLISH_CONFIRM_CODE 覆盖 */
export const DEFAULT_PUBLISH_CONFIRM_CODE = "DEDA2025";

export interface PromptAuthor {
  username: string;
  displayName?: string | null;
}

/** catalog 行：dashboard 列表页直接渲染，无需二次请求 */
export interface PromptCatalogItem {
  key: string;
  category: PromptCategory;
  scene: LlmScene | null;
  name: string;
  description: string;
  /** 变量契约。代码是唯一真相，这里给 dashboard 展示与前端校验用 */
  variables: PromptVariableSpec[];
  maxChars: number;
  /** 内置 key 的代码默认值；动态角色人设没有默认值，为 null */
  defaultContent: string | null;
  /** 运行时真正生效的正文（DB published，无则代码默认值；动态人设未发布为空串） */
  effectiveContent: string;
  source: PromptSource;
  /** true = 由 character_timbre 派生 / 后台创建的角色人设，不在 PROMPT_KEYS 内 */
  isDynamic: boolean;
  /** 动态人设关联的角色 key；内置 key 为 null */
  characterKey: string | null;
  /** 动态人设：该角色是否仍在 character_timbre；内置 key 为 null */
  characterRegistered: boolean | null;
  publishedRevision: number | null;
  draftRevision: number | null;
  publishedAt: string | null;
  publishedBy: string | null;
  /** 生效正文与代码默认值不一致 → dashboard 标「已偏离默认」（动态人设恒 false） */
  deviatesFromDefault: boolean;
}

export interface PromptDetail extends PromptCatalogItem {
  draftContent: string | null;
  draftChangeNote: string | null;
  publishedContent: string | null;
  /** 仅回滚时非 null：本次回滚丢弃的未发布草稿号（正文仍留在版本表，可从历史恢复） */
  discardedDraftRevision: number | null;
}

export interface PromptVersionItem {
  revision: number;
  content: string;
  changeNote: string | null;
  authorUsername: string;
  authorDisplayName: string | null;
  createdAt: string;
  publishedAt: string | null;
  isPublished: boolean;
  isDraft: boolean;
}

type Tx = Prisma.TransactionClient;

interface ResolvedPromptKey {
  key: string;
  /** 动态角色人设关联的 characterKey；内置 key 为 null */
  characterKey: string | null;
}

/**
 * Prompt 后台管理：dashboard 的 view / edit / publish 全部走这里。
 *
 * 三条不可妥协的语义：
 * 1. **确认码服务端校验**。前端弹窗只是提醒，真正的闸口在这里；
 *    前端可被绕过，而发布会立刻改变线上所有设备的模型行为。
 * 2. **版本单调递增、历史不可变**。回滚 = 以目标版本正文新建 revision 并发布
 *    （同 git revert），绝不改写或删除既有版本，审计链完整。
 * 3. **禁止删模板**。key 被代码引用，删行只会静默回落默认值，
 *    制造「以为改了其实没改」的错觉；「恢复默认」同样以新版本形式留痕。
 *
 * 状态不存 status 枚举：草稿/已发布完全由 draftRevision / publishedRevision
 * 两个指针派生，避免第三份状态与指针打架。
 */
@Injectable()
export class PromptAdminService {
  private readonly logger = new Logger(PromptAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptRegistry: PromptRegistryService,
    private readonly configService: ConfigService,
  ) {}

  /** 供 GET analytics/meta 使用：dashboard 据此决定是否放开编辑与展示确认码提示 */
  getWritePolicy(): {
    promptWriteEnabled: boolean;
    publishConfirmCode: string;
  } {
    return {
      promptWriteEnabled: this.isWriteEnabled(),
      publishConfirmCode:
        this.configService.get<string>("PROMPT_PUBLISH_CONFIRM_CODE") ||
        DEFAULT_PUBLISH_CONFIRM_CODE,
    };
  }

  /** 只有字面 false（大小写不敏感）才关写：避免 ops 打错值静默禁掉编辑能力 */
  isWriteEnabled(): boolean {
    const raw = this.configService.get<string>("PROMPT_WRITE_ENABLED");
    return raw?.trim().toLowerCase() !== "false";
  }

  /**
   * catalog = 内置 PROMPT_KEYS（顺序固定）∪ 动态角色人设。
   *
   * 动态人设来源有两个，合并去重：
   * 1. character_timbre 里已注册的角色（即使还没写过人设，也要出现一行，
   *    这样「新增角色」后 Prompt 管理立刻能看到「角色人设：xxx」）；
   * 2. 已存在的 persona_<key> 模板行（角色后来被删但人设仍在，标记为未注册）。
   */
  async list(): Promise<PromptCatalogItem[]> {
    // 先同步一次注册表：admin 看到的「当前生效」必须与运行时一致，
    // 不能是最长 60s 前的缓存快照
    await this.promptRegistry.reload();
    const [rows, characters] = await Promise.all([
      this.prisma.promptTemplate.findMany({
        where: {
          OR: [{ key: { in: [...PROMPT_KEYS] } }, { category: "persona" }],
        },
      }),
      this.prisma.characterTimbre.findMany({
        select: { characterKey: true },
        orderBy: { characterKey: "asc" },
      }),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const registered = new Set(characters.map((row) => row.characterKey));

    const dynamicKeys = new Set<string>();
    for (const characterKey of registered) {
      const key = personaKeyFor(characterKey);
      // elly/polly 是内置 key，静态 catalog 已覆盖，不能重复出现
      if (!isBuiltinPromptKey(key)) dynamicKeys.add(key);
    }
    for (const row of rows) {
      const characterKey = characterKeyFromPersonaKey(row.key);
      if (characterKey !== null && !isBuiltinPromptKey(row.key)) {
        dynamicKeys.add(row.key);
      }
    }

    const dynamicItems = [...dynamicKeys]
      .sort((a, b) => {
        const ca = characterKeyFromPersonaKey(a) ?? a;
        const cb = characterKeyFromPersonaKey(b) ?? b;
        return ca.localeCompare(cb);
      })
      .map((key) => {
        const characterKey = characterKeyFromPersonaKey(key) ?? key;
        return this.toDynamicCatalogItem(
          key,
          characterKey,
          byKey.get(key) ?? null,
          registered.has(characterKey),
        );
      });

    return [
      ...PROMPT_KEYS.map((key) =>
        this.toCatalogItem(key, byKey.get(key) ?? null),
      ),
      ...dynamicItems,
    ];
  }

  async get(key: string): Promise<PromptDetail> {
    const { key: promptKey } = await this.resolveKey(key);
    await this.promptRegistry.reload();
    return this.buildDetail(promptKey);
  }

  async listVersions(key: string): Promise<PromptVersionItem[]> {
    const { key: promptKey } = await this.resolveKey(key);
    const row = await this.prisma.promptTemplate.findUnique({
      where: { key: promptKey },
    });
    // 从未编辑过的 key 没有 DB 行：返回空数组而非 404，catalog 恒在
    if (!row) return [];
    const versions = await this.prisma.promptTemplateVersion.findMany({
      where: { templateId: row.id },
      orderBy: { revision: "desc" },
    });
    return versions.map((version) => ({
      revision: version.revision,
      content: version.content,
      changeNote: version.changeNote,
      authorUsername: version.authorUsername,
      authorDisplayName: version.authorDisplayName,
      createdAt: version.createdAt.toISOString(),
      publishedAt: version.publishedAt
        ? version.publishedAt.toISOString()
        : null,
      isPublished: row.publishedRevision === version.revision,
      isDraft: row.draftRevision === version.revision,
    }));
  }

  /**
   * 保存草稿。首次编辑才惰性建 template 行（启动不 seed，代码即 catalog）。
   * expectedRevision 乐观锁：两个 admin 同时编辑时后者拿 409，不会静默覆盖。
   */
  async saveDraft(
    key: string,
    dto: SavePromptDraftDto,
    author: PromptAuthor,
  ): Promise<PromptDetail> {
    this.assertWritable();
    const resolved = await this.resolveKey(key);
    const promptKey = resolved.key;
    this.assertPlaceholderContract(promptKey, dto.content);

    await this.prisma.$transaction(async (tx) => {
      const row = await this.ensureRow(tx, resolved);
      const current = row.draftRevision ?? 0;
      if (current !== dto.expectedRevision) {
        throw new ConflictException(
          `草稿已被他人更新（当前 r${current}，你的编辑基于 r${dto.expectedRevision}）；请刷新后重试`,
        );
      }
      if (current === 0) {
        const revision = await this.nextRevision(tx, row.id);
        await tx.promptTemplateVersion.create({
          data: {
            templateId: row.id,
            revision,
            content: dto.content,
            changeNote: dto.changeNote ?? null,
            authorUsername: author.username,
            authorDisplayName: author.displayName ?? null,
          },
        });
        await tx.promptTemplate.update({
          where: { id: row.id },
          data: { draftRevision: revision },
        });
      } else {
        // 就地更新同一草稿：反复保存不制造版本噪音
        await tx.promptTemplateVersion.update({
          where: {
            templateId_revision: { templateId: row.id, revision: current },
          },
          data: {
            content: dto.content,
            changeNote: dto.changeNote ?? null,
            authorUsername: author.username,
            authorDisplayName: author.displayName ?? null,
          },
        });
      }
    });

    // 刻意不刷新注册表：草稿不影响线上生效内容
    return this.buildDetail(promptKey);
  }

  async publish(
    key: string,
    dto: PublishPromptDto,
    author: PromptAuthor,
  ): Promise<PromptDetail> {
    this.assertWritable();
    this.assertConfirmCode(dto.confirmCode);
    const { key: promptKey } = await this.resolveKey(key);

    await this.prisma.$transaction(async (tx) => {
      const row = await tx.promptTemplate.findUnique({
        where: { key: promptKey },
      });
      if (!row || row.draftRevision === null) {
        throw new ConflictException("没有待发布的草稿");
      }
      if (row.draftRevision !== dto.revision) {
        throw new ConflictException(
          `草稿已变为 r${row.draftRevision}，你要发布的是 r${dto.revision}；请刷新后重试`,
        );
      }
      const publishedAt = new Date();
      await tx.promptTemplateVersion.update({
        where: {
          templateId_revision: { templateId: row.id, revision: dto.revision },
        },
        // 发布说明以 publish 时填的为准：一个版本一条「为什么上线」
        data: { publishedAt, changeNote: dto.changeNote },
      });
      await tx.promptTemplate.update({
        where: { id: row.id },
        data: {
          publishedRevision: dto.revision,
          publishedAt,
          publishedBy: author.username,
          draftRevision: null,
        },
      });
    });

    await this.refreshRegistry(promptKey, "publish");
    return this.buildDetail(promptKey);
  }

  /**
   * 回滚 = 以目标版本正文新建 revision 并直接发布（git revert 语义）。
   * 未发布草稿会被清掉，但正文仍在版本表里，可从历史重新取用；
   * 被丢弃的草稿号通过 discardedDraftRevision 回给前端提示。
   */
  async rollback(
    key: string,
    dto: RollbackPromptDto,
    author: PromptAuthor,
  ): Promise<PromptDetail> {
    this.assertWritable();
    this.assertConfirmCode(dto.confirmCode);
    const { key: promptKey } = await this.resolveKey(key);
    let discardedDraftRevision: number | null = null;

    await this.prisma.$transaction(async (tx) => {
      const row = await tx.promptTemplate.findUnique({
        where: { key: promptKey },
      });
      if (!row) {
        throw new NotFoundException(
          `「${promptKey}」尚无任何版本，无可回滚目标；如需固定默认值请用「恢复代码默认值」`,
        );
      }
      const target = await tx.promptTemplateVersion.findUnique({
        where: {
          templateId_revision: {
            templateId: row.id,
            revision: dto.targetRevision,
          },
        },
      });
      if (!target) {
        throw new NotFoundException(`版本 r${dto.targetRevision} 不存在`);
      }
      const revision = await this.nextRevision(tx, row.id);
      const publishedAt = new Date();
      await tx.promptTemplateVersion.create({
        data: {
          templateId: row.id,
          revision,
          content: target.content,
          changeNote: `回滚至 r${dto.targetRevision}：${dto.changeNote}`,
          authorUsername: author.username,
          authorDisplayName: author.displayName ?? null,
          publishedAt,
        },
      });
      discardedDraftRevision = row.draftRevision;
      await tx.promptTemplate.update({
        where: { id: row.id },
        data: {
          publishedRevision: revision,
          publishedAt,
          publishedBy: author.username,
          draftRevision: null,
        },
      });
    });

    await this.refreshRegistry(promptKey, "rollback");
    return {
      ...(await this.buildDetail(promptKey)),
      discardedDraftRevision,
    };
  }

  /**
   * 恢复代码默认值：以 PROMPT_DEFAULTS 正文新建 revision 并发布。
   * 不删行、不置空指针——审计链上留下「谁在什么时候把它恢复成了默认」。
   */
  async resetToDefault(
    key: string,
    dto: ResetPromptToDefaultDto,
    author: PromptAuthor,
  ): Promise<PromptDetail> {
    this.assertWritable();
    this.assertConfirmCode(dto.confirmCode);
    const resolved = await this.resolveKey(key);
    if (resolved.characterKey !== null) {
      throw new BadRequestException(
        "动态角色人设没有代码默认值，无法恢复默认；请从历史版本回滚",
      );
    }
    const promptKey = resolved.key;

    await this.prisma.$transaction(async (tx) => {
      const row = await this.ensureRow(tx, resolved);
      const revision = await this.nextRevision(tx, row.id);
      const publishedAt = new Date();
      await tx.promptTemplateVersion.create({
        data: {
          templateId: row.id,
          revision,
          content: PROMPT_DEFAULTS[promptKey].template,
          changeNote: `恢复代码默认值：${dto.changeNote}`,
          authorUsername: author.username,
          authorDisplayName: author.displayName ?? null,
          publishedAt,
        },
      });
      await tx.promptTemplate.update({
        where: { id: row.id },
        data: {
          publishedRevision: revision,
          publishedAt,
          publishedBy: author.username,
          draftRevision: null,
        },
      });
    });

    await this.refreshRegistry(promptKey, "reset-to-default");
    return this.buildDetail(promptKey);
  }

  // ---------------------------------------------------------------- internals

  /**
   * 变更后刷新注册表。
   *
   * 用 reload() 而不是 invalidate()：invalidate 会先清空缓存，
   * 于是下一次读取在后台重载完成前会**回落到代码默认值**——
   * 等于刚发布的新 prompt 有一个窗口期不生效（对安全分类器尤其不可接受）。
   * reload 是「读到新数据后整体替换」，切换是原子的。
   */
  private async refreshRegistry(key: string, action: string): Promise<void> {
    try {
      await this.promptRegistry.reload();
    } catch (error) {
      // 刷新失败不回滚已提交的发布：DB 是真相，缓存最长 TTL 后自愈
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Prompt registry refresh after ${action} of "${key}" failed: ${message}`,
      );
    }
  }

  private assertWritable(): void {
    if (!this.isWriteEnabled()) {
      throw new ForbiddenException(
        "Prompt 写入已被运维开关关闭（PROMPT_WRITE_ENABLED=false）",
      );
    }
  }

  /**
   * 定长比较，避免确认码被时序侧信道逐字符猜出。
   *
   * 错误码是 400 而不是 403：dashboard 的 axios 响应拦截器把 401/403 一律
   * 当「凭据失效」处理（清 token 跳登录页），而确认码打错只是这一次请求的
   * 参数不对，不该把管理员踢下线、连带丢掉编辑器里的草稿。
   * 403 只留给 assertWritable 那种「这个环境根本不允许写」的策略拒绝。
   */
  private assertConfirmCode(confirmCode: string): void {
    const expected = this.getWritePolicy().publishConfirmCode;
    const given = Buffer.from(confirmCode ?? "", "utf8");
    const want = Buffer.from(expected, "utf8");
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new BadRequestException("确认码不正确，操作已取消");
    }
  }

  /**
   * 校验并解析 key。
   *
   * - 内置 key 直接通过；
   * - `persona_<characterKey>` 需要通过「角色已在 character_timbre 注册」
   *   或「已存在该模板行（角色被删后仍可维护历史人设）」二者之一；
   * - 其余一律 404。动态人设不允许凭空创建（避免拼错角色名造出孤儿模板）。
   */
  private async resolveKey(key: string): Promise<ResolvedPromptKey> {
    if (isBuiltinPromptKey(key)) {
      return { key, characterKey: null };
    }

    const characterKey = characterKeyFromPersonaKey(key);
    if (characterKey !== null) {
      const [timbre, row] = await Promise.all([
        this.prisma.characterTimbre.findUnique({ where: { characterKey } }),
        this.prisma.promptTemplate.findUnique({ where: { key } }),
      ]);
      if (timbre || row) {
        return { key, characterKey };
      }
    }

    throw new NotFoundException(`未知的 prompt key：${key}`);
  }

  /**
   * 草稿正文的占位符必须落在代码变量契约内。
   *
   * 运行时渲染遇到未声明占位符会整体回落默认话术，等于 admin 的改动静默失效；
   * 这里在保存草稿时提前拒绝，把「发布了但没生效」挡在源头。
   * 动态人设没有变量契约，任何占位符都不接受。
   */
  private assertPlaceholderContract(key: string, content: string): void {
    const spec = isBuiltinPromptKey(key) ? PROMPT_DEFAULTS[key].variables : [];
    const declared = new Set(spec.map((entry) => entry.name));
    const unknown = findPlaceholders(content).filter(
      (name) => !declared.has(name),
    );
    if (unknown.length > 0) {
      const labels = unknown.map((name) => `{{${name}}}`).join("、");
      throw new BadRequestException(
        `模板含未声明占位符：${labels}；变量契约由服务端代码定义，请改用已声明的变量或删除占位符`,
      );
    }
  }

  /** 惰性建行；两个 admin 同时首次编辑时靠 P2002 重试收敛到同一行 */
  private async ensureRow(
    tx: Tx,
    resolved: ResolvedPromptKey,
  ): Promise<PromptTemplate> {
    const { key, characterKey } = resolved;
    const existing = await tx.promptTemplate.findUnique({ where: { key } });
    if (existing) return existing;

    const data =
      characterKey === null
        ? (() => {
            const def = PROMPT_DEFAULTS[key as PromptKey];
            return {
              key,
              category: def.category,
              scene: def.scene,
              name: def.name,
              description: def.description,
              renderSchema: def.variables as unknown as Prisma.InputJsonValue,
            };
          })()
        : {
            key,
            category: "persona",
            scene: null,
            name: `角色人设：${characterKey}`,
            description: `角色 ${characterKey} 的人设（后台创建，无代码默认值）。未发布时运行时回落 Elly。`,
            renderSchema: [] as unknown as Prisma.InputJsonValue,
          };

    try {
      return await tx.promptTemplate.create({ data });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await tx.promptTemplate.findUnique({ where: { key } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async nextRevision(tx: Tx, templateId: string): Promise<number> {
    const last = await tx.promptTemplateVersion.findFirst({
      where: { templateId },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });
    return (last?.revision ?? 0) + 1;
  }

  private toCatalogItem(
    key: PromptKey,
    row: PromptTemplate | null,
  ): PromptCatalogItem {
    const def = PROMPT_DEFAULTS[key];
    const resolved = this.promptRegistry.resolveTemplate(key);
    return {
      key,
      category: def.category,
      scene: def.scene,
      name: def.name,
      description: def.description,
      variables: def.variables,
      maxChars: PROMPT_CONTENT_MAX_CHARS,
      defaultContent: def.template,
      effectiveContent: resolved.content,
      source: resolved.source,
      isDynamic: false,
      characterKey: null,
      characterRegistered: null,
      publishedRevision: row?.publishedRevision ?? null,
      draftRevision: row?.draftRevision ?? null,
      publishedAt: row?.publishedAt ? row.publishedAt.toISOString() : null,
      publishedBy: row?.publishedBy ?? null,
      deviatesFromDefault: resolved.content !== def.template,
    };
  }

  private toDynamicCatalogItem(
    key: string,
    characterKey: string,
    row: PromptTemplate | null,
    characterRegistered: boolean,
  ): PromptCatalogItem {
    const dynamic = this.promptRegistry.getDynamicPersona(characterKey);
    return {
      key,
      category: "persona",
      scene: null,
      name: `角色人设：${characterKey}`,
      description: `角色 ${characterKey} 的人设（后台创建，无代码默认值）。未发布时运行时回落 Elly。`,
      variables: [],
      maxChars: PROMPT_CONTENT_MAX_CHARS,
      defaultContent: null,
      effectiveContent: dynamic?.content ?? "",
      source: dynamic ? "db" : "none",
      isDynamic: true,
      characterKey,
      characterRegistered,
      publishedRevision: row?.publishedRevision ?? null,
      draftRevision: row?.draftRevision ?? null,
      publishedAt: row?.publishedAt ? row.publishedAt.toISOString() : null,
      publishedBy: row?.publishedBy ?? null,
      deviatesFromDefault: false,
    };
  }

  private async buildDetail(key: string): Promise<PromptDetail> {
    const row = await this.prisma.promptTemplate.findUnique({ where: { key } });
    let draftContent: string | null = null;
    let draftChangeNote: string | null = null;
    let publishedContent: string | null = null;

    if (row?.draftRevision != null) {
      const draft = await this.prisma.promptTemplateVersion.findUnique({
        where: {
          templateId_revision: {
            templateId: row.id,
            revision: row.draftRevision,
          },
        },
      });
      draftContent = draft?.content ?? null;
      draftChangeNote = draft?.changeNote ?? null;
    }
    if (row?.publishedRevision != null) {
      const published = await this.prisma.promptTemplateVersion.findUnique({
        where: {
          templateId_revision: {
            templateId: row.id,
            revision: row.publishedRevision,
          },
        },
      });
      publishedContent = published?.content ?? null;
    }

    const characterKey = characterKeyFromPersonaKey(key);
    let base: PromptCatalogItem;
    if (characterKey !== null && !isBuiltinPromptKey(key)) {
      const timbre = await this.prisma.characterTimbre.findUnique({
        where: { characterKey },
        select: { characterKey: true },
      });
      base = this.toDynamicCatalogItem(key, characterKey, row, timbre !== null);
    } else {
      base = this.toCatalogItem(key as PromptKey, row);
    }

    return {
      ...base,
      draftContent,
      draftChangeNote,
      publishedContent,
      discardedDraftRevision: null,
    };
  }
}
