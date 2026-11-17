import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PROMPT_DEFAULTS } from "./prompt-defaults";
import { PROMPT_KEYS, type PromptKey } from "./prompt-keys";
import { PromptRenderError, renderPrompt } from "./prompt-render.util";

export type PromptSource = "db" | "default";

export interface ResolvedPrompt {
  /** 模板正文（未渲染） */
  content: string;
  /** 生效版本号；source=default 时为 null */
  revision: number | null;
  source: PromptSource;
}

/** 缓存有效期：过期后同步读取仍立即返回旧值，同时后台重载（stale-while-revalidate） */
const CACHE_TTL_MS = 60_000;

/** DB 故障后的重试间隔：避免每轮对话都去撞一次挂掉的库 */
const FAILURE_RETRY_MS = 5_000;

const PERSONA_KEY_BY_CHARACTER: Record<string, PromptKey> = {
  elly: "persona_elly",
  polly: "persona_polly",
};

/** 未知/缺省 characterKey 一律回落 elly：杜绝匿名人设导致模型自编身份 */
const DEFAULT_PERSONA_KEY: PromptKey = "persona_elly";

/**
 * 故事意图 → 话术模板 key。
 * adventure_story / free_story 走到这里说明冒险未真正开始（门禁拦截或无集可播），
 * 统一走「自由创作、不承诺冒险」的降级话术，故共用 story_prompt_free。
 * 键类型收宽为 string：调用方传入的是 vendor 的 ConversationIntent 联合，
 * 本模块不反向依赖 vendor 的类型定义。
 */
const STORY_PROMPT_KEY_BY_INTENT: Record<string, PromptKey> = {
  english_story: "story_prompt_english",
  idiom_story: "story_prompt_idiom",
  sleep_story: "story_prompt_sleep",
  adventure_story: "story_prompt_free",
  free_story: "story_prompt_free",
};

/**
 * Prompt 注册表：17 个可编辑 prompt 的运行时读取入口。
 *
 * 对业务侧只暴露**同步**方法。LlmService 的三个 prompt builder 都是同步的，
 * 若改成 async 会波及全部调用点与既有测试；这里改为启动预载 + 内存缓存 +
 * stale-while-revalidate，热路径零 await、零 DB 往返。
 *
 * fail-safe 优先级：DB published 内容 → 代码内 PROMPT_DEFAULTS → 抛错。
 * 前两级都失败（默认模板渲染不了）属代码 bug，必须抛出来，
 * 绝不静默把 `{{xxx}}` 发给模型。
 *
 * 缓存一致性：单实例部署下 publish/rollback 会 await reload() 原子换入新内容
 * （不清空缓存，故不存在「短暂回落代码默认值」的窗口）；
 * 多实例部署时其余实例最长滞后 CACHE_TTL_MS。
 */
@Injectable()
export class PromptRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PromptRegistryService.name);
  private readonly cache = new Map<
    PromptKey,
    { content: string; revision: number }
  >();
  private loadedAt = 0;
  private nextRetryAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** 启动时加载一次；DB 不可用只记日志，全部 key 走代码默认值 */
  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  /**
   * 取生效模板正文（未渲染）。缓存过期时立即返回旧值并触发后台重载。
   * 任何情况下都有返回值：无 DB 内容时回落 PROMPT_DEFAULTS。
   */
  getTemplate(key: PromptKey): string {
    return this.resolveTemplate(key).content;
  }

  /** 取生效模板并附带来源信息，供可观测性与 dashboard「已偏离默认」标记使用 */
  resolveTemplate(key: PromptKey): ResolvedPrompt {
    this.refreshIfStale();
    const cached = this.cache.get(key);
    if (cached) {
      return {
        content: cached.content,
        revision: cached.revision,
        source: "db",
      };
    }
    return {
      content: PROMPT_DEFAULTS[key].template,
      revision: null,
      source: "default",
    };
  }

  /**
   * 取生效模板并渲染变量。
   * DB 内容渲染失败（admin 写了未声明占位符、必填变量缺失等）→ 记 warn 并
   * 回落默认模板重渲染；默认模板也渲染失败 → 抛 PromptRenderError。
   */
  render(key: PromptKey, vars?: Record<string, unknown>): string {
    const spec = PROMPT_DEFAULTS[key].variables;
    const resolved = this.resolveTemplate(key);
    const fallback = () =>
      renderPrompt(PROMPT_DEFAULTS[key].template, vars ?? {}, spec);

    if (resolved.source === "default") {
      return fallback();
    }
    try {
      return renderPrompt(resolved.content, vars ?? {}, spec);
    } catch (error) {
      if (!(error instanceof PromptRenderError)) throw error;
      this.logger.warn(
        `Prompt "${key}" revision ${resolved.revision} failed to render, ` +
          `falling back to code default: ${error.message}`,
      );
      return fallback();
    }
  }

  /**
   * 取角色人设。未知/缺省 characterKey 回落 elly，与既有
   * CHARACTER_PERSONAS[key] ?? CHARACTER_PERSONAS.elly 行为一致。
   */
  getPersona(characterKey?: string | null): string {
    const key =
      (characterKey != null
        ? PERSONA_KEY_BY_CHARACTER[characterKey]
        : undefined) ?? DEFAULT_PERSONA_KEY;
    return this.getTemplate(key);
  }

  /**
   * 故事意图话术。取代 llm-adapter.service 与 vendor.service 里两份逐字重复的
   * 私有 storyPrompt（此前靠注释「两处需同步修改」维系一致）。
   * 非故事意图返回 undefined，与既有 default 分支语义一致。
   *
   * favoriteStoryType 为孩子长期记忆里的最爱故事类型：只在传入时追加一段
   * 「优先讲这个类型」的软提示；vendor 链路不传，故无追加段。
   */
  getStoryPrompt(
    intent: string,
    favoriteStoryType?: string | null,
  ): string | undefined {
    const key = STORY_PROMPT_KEY_BY_INTENT[intent];
    if (!key) return undefined;
    const base = this.getTemplate(key);
    if (!favoriteStoryType) return base;
    return (
      base + this.render("story_favorite_type_suffix", { favoriteStoryType })
    );
  }

  /** 强制从 DB 重载。失败时保留现有缓存，只记 warn，不抛错 */
  async reload(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const task = this.doReload().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = task;
    return task;
  }

  private async doReload(): Promise<void> {
    try {
      const templates = await this.prisma.promptTemplate.findMany({
        where: {
          key: { in: [...PROMPT_KEYS] },
          publishedRevision: { not: null },
        },
        select: { id: true, key: true, publishedRevision: true },
      });

      const pairs = templates.flatMap((template) =>
        template.publishedRevision === null
          ? []
          : [{ templateId: template.id, revision: template.publishedRevision }],
      );

      const next = new Map<PromptKey, { content: string; revision: number }>();
      if (pairs.length > 0) {
        const versions = await this.prisma.promptTemplateVersion.findMany({
          where: { OR: pairs },
          select: { templateId: true, revision: true, content: true },
        });
        const keyByTemplateId = new Map(
          templates.map((template) => [template.id, template.key]),
        );
        for (const version of versions) {
          const key = keyByTemplateId.get(version.templateId) as
            PromptKey | undefined;
          if (!key) continue;
          if (
            typeof version.content !== "string" ||
            version.content.length === 0
          ) {
            this.logger.warn(
              `Prompt "${key}" revision ${version.revision} has empty content in DB; using code default`,
            );
            continue;
          }
          next.set(key, {
            content: version.content,
            revision: version.revision,
          });
        }
      }

      // 整体替换而非增量合并：撤销发布（publishedRevision 变 null）必须能回落默认
      this.cache.clear();
      for (const [key, value] of next) {
        this.cache.set(key, value);
      }
      this.loadedAt = Date.now();
      this.nextRetryAt = 0;
    } catch (error) {
      // 保留现有缓存（可能为空 → 全走默认值），延后重试，绝不影响主链路
      this.nextRetryAt = Date.now() + FAILURE_RETRY_MS;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Prompt registry reload failed, serving ${this.cache.size} cached / code defaults: ${message}`,
      );
    }
  }

  /** 过期则触发后台重载（不 await）；故障冷却期内不重复尝试 */
  private refreshIfStale(): void {
    const now = Date.now();
    if (this.loadedAt !== 0 && now - this.loadedAt < CACHE_TTL_MS) return;
    if (this.inFlight) return;
    if (now < this.nextRetryAt) return;
    void this.reload().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Background prompt registry reload failed: ${message}`);
    });
  }
}
