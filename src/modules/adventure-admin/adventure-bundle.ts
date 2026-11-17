import { createHash } from "crypto";
import {
  ADVENTURE_CHARACTER_KEYS,
  ADVENTURE_INTERACTION_TYPES,
  AdventureCharacterKey,
  AdventureInteractionType,
  businessKey,
  EpisodeContentDraft,
  EpisodeIdentity,
  SegmentOptions,
  TwoChoiceOption,
} from "./adventure-content.types";

/**
 * 冒险内容 bundle：staging → prod 的唯一搬运载体。
 *
 * 三条不可让步的不变量：
 * 1. **内容哈希与环境无关**。exportedAt 与 sourceProfile 不参与哈希，否则同一份内容
 *    在 staging 与 prod 会算出不同 hash，`already_up_to_date` 永远判不出来，
 *    admin 会反复导入同一份内容并制造无意义的版本。
 * 2. **bundle 不携带行身份**。id / episodeId / currentVersionId / createdAt / updatedAt
 *    一律不进 bundle：prod 的行 id 与 staging 无关，带过去只会制造错误关联。
 * 3. **bundle 不携带发布态**。published / retiredAt 不进 bundle：把内容搬到 prod
 *    与「让 prod 的孩子听到它」必须是两个独立、各自需要确认的动作。
 *
 * 解析侧一律白名单重建对象，手改过的 bundle 无法夹带字段，也不会污染原型。
 */

export const BUNDLE_SCHEMA_VERSION = 1;

export interface BundleSegment {
  order: number;
  kind: "narration" | "interaction";
  text: string;
  interactionType: AdventureInteractionType | null;
  options: SegmentOptions | null;
  fallbackText: string | null;
  exitText: string | null;
  rewardStar: boolean;
}

export interface BundleEpisode {
  characterKey: AdventureCharacterKey;
  season: number;
  episodeNumber: number;
  title: string;
  recap: string | null;
  segments: BundleSegment[];
}

export interface AdventureBundle {
  bundleSchemaVersion: number;
  /** 导出时间，仅供人看；不参与哈希 */
  exportedAt: string;
  /** 导出环境（authoring / readonly），仅供人看；不参与哈希 */
  sourceProfile: string;
  episodes: BundleEpisode[];
}

export interface BundleSourceEpisode {
  identity: EpisodeIdentity;
  content: EpisodeContentDraft;
}

/**
 * 解析结果刻意做成扁平结构而不是判别式联合：本仓库 tsconfig 关掉了 strictNullChecks，
 * 布尔字面量判别式不会收窄，消费方（controller / 前端类型）会被迫到处断言。
 */
export interface ParseBundleResult {
  ok: boolean;
  /** ok=false 时为 null */
  bundle: AdventureBundle | null;
  errors: string[];
  warnings: string[];
}

export interface SegmentDiff {
  order: number;
  change: "added" | "removed" | "modified";
  field?: string;
  before?: unknown;
  after?: unknown;
}

export interface EpisodeDiff {
  businessKey: string;
  change: "added" | "replaced" | "identical";
  titleChanged: boolean;
  recapChanged: boolean;
  segmentDiffs: SegmentDiff[];
}

export interface ExistingEpisodeForImport {
  id: string;
  characterKey: string;
  season: number;
  episodeNumber: number;
  published: boolean;
  retiredAt: Date | string | null;
  /** 目标集当前发布版本的内容哈希；null 表示历史数据没有 hash，只能按「不同」处理 */
  currentContentHash: string | null;
  /** 目标集当前内容，用于生成段级 diff；缺省时 diff 把整集视为新增 */
  currentEpisode?: BundleEpisode | null;
}

export type ImportAction = "add" | "replace" | "already_up_to_date" | "reject";

export interface ImportEpisodePlan {
  businessKey: string;
  action: ImportAction;
  incomingHash: string;
  existingHash: string | null;
  episodeId?: string;
  reason?: string;
  diff?: EpisodeDiff;
}

export interface ImportPlan {
  /** 无 reject 才允许提交；dry-run 与真实导入用同一份计划 */
  ok: boolean;
  bundleHash: string;
  items: ImportEpisodePlan[];
  adds: number;
  replaces: number;
  upToDate: number;
  rejects: number;
}

const SEGMENT_FIELDS = [
  "kind",
  "text",
  "interactionType",
  "options",
  "fallbackText",
  "exitText",
  "rewardStar",
] as const;

/**
 * 确定性 JSON：递归排序对象键、保留数组顺序、丢弃 undefined。
 * 哈希必须只由内容决定，不能由字段写入顺序决定。
 */
export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 单集内容指纹；写入 AdventureEpisodeVersion.contentHash，也是导入比对的依据。 */
export function episodeContentHash(episode: BundleEpisode): string {
  return sha256(canonicalJson(episode));
}

/** 整个 bundle 的内容指纹；写入审计的 sourceBundleHash，用于事后对账。 */
export function bundleContentHash(bundle: AdventureBundle): string {
  return sha256(
    canonicalJson({
      bundleSchemaVersion: bundle.bundleSchemaVersion,
      episodes: bundle.episodes,
    }),
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNullableString(value: unknown): string | null {
  const text = asString(value);
  return text ? text : null;
}

function normalizeOptions(
  raw: unknown,
  interactionType: AdventureInteractionType | null,
): SegmentOptions | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as Record<string, unknown>;
  if (interactionType === "two_choice") {
    if (!Array.isArray(source.choices)) {
      return null;
    }
    const choices: TwoChoiceOption[] = [];
    for (const item of source.choices) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const choice = item as Record<string, unknown>;
      choices.push({
        key: asString(choice.key),
        text: asString(choice.text),
        reply: asString(choice.reply),
      });
    }
    return { choices };
  }
  if (interactionType === "repeat_after_me") {
    const praise = asNullableString(source.praise);
    return praise ? { praise } : null;
  }
  return null;
}

function normalizeSegment(raw: Record<string, unknown>): BundleSegment | null {
  const order = Number(raw.order);
  const kind = raw.kind;
  const text = asString(raw.text);
  if (!Number.isInteger(order) || order < 0) {
    return null;
  }
  if (kind !== "narration" && kind !== "interaction") {
    return null;
  }
  if (!text) {
    return null;
  }
  const rawType = raw.interactionType;
  const interactionType = ADVENTURE_INTERACTION_TYPES.includes(
    rawType as (typeof ADVENTURE_INTERACTION_TYPES)[number],
  )
    ? (rawType as AdventureInteractionType)
    : null;
  return {
    order,
    kind: kind as "narration" | "interaction",
    text,
    interactionType: kind === "interaction" ? interactionType : null,
    options:
      kind === "interaction"
        ? normalizeOptions(raw.options, interactionType)
        : null,
    fallbackText: asNullableString(raw.fallbackText),
    exitText: asNullableString(raw.exitText),
    rewardStar: raw.rewardStar === true,
  };
}

/** 把身份 + 内容草稿压成 bundle 里的白名单形状：外壳字段在此被剥掉。 */
export function toBundleEpisode(
  identity: EpisodeIdentity,
  content: EpisodeContentDraft,
): BundleEpisode {
  const rawSegments = Array.isArray(content?.segments) ? content.segments : [];
  const segments = rawSegments
    .map((segment) =>
      segment && typeof segment === "object"
        ? normalizeSegment(segment as unknown as Record<string, unknown>)
        : null,
    )
    .filter((segment): segment is BundleSegment => segment !== null)
    .sort((a, b) => a.order - b.order);

  return {
    characterKey: identity.characterKey,
    season: identity.season,
    episodeNumber: identity.episodeNumber,
    title: asString(content?.title),
    recap: asNullableString(content?.recap),
    segments,
  };
}

export function buildBundle(
  episodes: BundleSourceEpisode[],
  options: { sourceProfile: string; exportedAt?: string },
): AdventureBundle {
  const normalized = episodes.map((item) =>
    toBundleEpisode(item.identity, item.content),
  );
  normalized.sort(
    (a, b) =>
      a.characterKey.localeCompare(b.characterKey) ||
      a.season - b.season ||
      a.episodeNumber - b.episodeNumber,
  );
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    sourceProfile: options.sourceProfile,
    episodes: normalized,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 解析并校验外部传入的 bundle。白名单重建，未知字段一律丢弃。
 * 结构级问题（版本不符、缺身份）判 error；个别畸形段落只丢弃并记 warning，
 * 不让一段坏数据毁掉整个 bundle 的导入。
 */
export function parseBundle(raw: unknown): ParseBundleResult {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      bundle: null,
      errors: ["bundle 必须是一个 JSON 对象。"],
      warnings,
    };
  }

  const errors: string[] = [];
  const version = raw.bundleSchemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    errors.push(
      `bundleSchemaVersion 缺失或不是整数（收到 ${String(version)}）；无法判断这份 bundle 的结构。`,
    );
  } else if (version > BUNDLE_SCHEMA_VERSION) {
    errors.push(
      `bundleSchemaVersion=${version} 高于本服务支持的 ${BUNDLE_SCHEMA_VERSION}；请升级服务端后再导入，不做猜测性兼容。`,
    );
  } else if (version < BUNDLE_SCHEMA_VERSION) {
    warnings.push(
      `bundleSchemaVersion=${version} 低于当前 ${BUNDLE_SCHEMA_VERSION}，按当前结构解析。`,
    );
  }

  if (!Array.isArray(raw.episodes)) {
    errors.push("bundle.episodes 缺失或不是数组。");
    return { ok: false, bundle: null, errors, warnings };
  }
  if (raw.episodes.length === 0) {
    errors.push("bundle.episodes 为空，没有可导入的内容。");
    return { ok: false, bundle: null, errors, warnings };
  }

  const episodes: BundleEpisode[] = [];
  raw.episodes.forEach((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`episodes[${index}] 不是对象，已跳过。`);
      return;
    }
    const characterKey = item.characterKey;
    if (
      !ADVENTURE_CHARACTER_KEYS.includes(
        characterKey as (typeof ADVENTURE_CHARACTER_KEYS)[number],
      )
    ) {
      errors.push(
        `episodes[${index}].characterKey "${String(
          characterKey,
        )}" 不在白名单内（${ADVENTURE_CHARACTER_KEYS.join(" / ")}）。`,
      );
      return;
    }
    const season = Number(item.season);
    if (!Number.isInteger(season) || season < 1) {
      errors.push(
        `episodes[${index}].season "${String(item.season)}" 不是不小于 1 的整数。`,
      );
      return;
    }
    const episodeNumber = Number(item.episodeNumber);
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1) {
      errors.push(
        `episodes[${index}].episodeNumber "${String(
          item.episodeNumber,
        )}" 不是不小于 1 的整数。`,
      );
      return;
    }
    const title = asString(item.title);
    if (!title) {
      errors.push(`episodes[${index}].title 不能为空。`);
      return;
    }
    if (!Array.isArray(item.segments)) {
      errors.push(`episodes[${index}].segments 缺失或不是数组。`);
      return;
    }

    const segments: BundleSegment[] = [];
    item.segments.forEach((rawSegment, segmentIndex) => {
      if (!isPlainObject(rawSegment)) {
        warnings.push(
          `episodes[${index}].segments[${segmentIndex}] 不是对象，已丢弃。`,
        );
        return;
      }
      const segment = normalizeSegment(rawSegment);
      if (!segment) {
        warnings.push(
          `episodes[${index}].segments[${segmentIndex}] 结构不完整（order/kind/text 之一非法），已丢弃。`,
        );
        return;
      }
      segments.push(segment);
    });
    segments.sort((a, b) => a.order - b.order);

    episodes.push({
      characterKey: characterKey as AdventureCharacterKey,
      season,
      episodeNumber,
      title,
      recap: asNullableString(item.recap),
      segments,
    });
  });

  if (errors.length > 0) {
    return { ok: false, bundle: null, errors, warnings };
  }
  return {
    ok: true,
    bundle: {
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
      exportedAt: asString(raw.exportedAt) || new Date().toISOString(),
      sourceProfile: asString(raw.sourceProfile) || "unknown",
      episodes,
    },
    errors: [],
    warnings,
  };
}

function episodeKey(episode: {
  characterKey: string;
  season: number;
  episodeNumber: number;
}): string {
  return businessKey({
    characterKey: episode.characterKey as AdventureCharacterKey,
    season: episode.season,
    episodeNumber: episode.episodeNumber,
  });
}

/** 段级 diff：给 admin 在导入前看清「到底改了什么」，而不是只看到一个 hash 不等。 */
export function diffEpisodes(
  before: BundleEpisode | null,
  after: BundleEpisode,
): EpisodeDiff {
  const key = episodeKey(after);
  if (!before) {
    return {
      businessKey: key,
      change: "added",
      titleChanged: true,
      recapChanged: true,
      segmentDiffs: after.segments.map((segment) => ({
        order: segment.order,
        change: "added" as const,
        after: segment,
      })),
    };
  }

  const titleChanged = before.title !== after.title;
  const recapChanged = before.recap !== after.recap;
  const beforeByOrder = new Map(before.segments.map((s) => [s.order, s]));
  const afterByOrder = new Map(after.segments.map((s) => [s.order, s]));
  const segmentDiffs: SegmentDiff[] = [];

  for (const [order, segment] of beforeByOrder) {
    if (!afterByOrder.has(order)) {
      segmentDiffs.push({ order, change: "removed", before: segment });
    }
  }
  for (const [order, segment] of afterByOrder) {
    const previous = beforeByOrder.get(order);
    if (!previous) {
      segmentDiffs.push({ order, change: "added", after: segment });
      continue;
    }
    for (const field of SEGMENT_FIELDS) {
      const beforeValue = canonicalJson(previous[field]);
      const afterValue = canonicalJson(segment[field]);
      if (beforeValue !== afterValue) {
        segmentDiffs.push({
          order,
          change: "modified",
          field,
          before: previous[field],
          after: segment[field],
        });
      }
    }
  }
  segmentDiffs.sort((a, b) => a.order - b.order);

  const changed = titleChanged || recapChanged || segmentDiffs.length > 0;
  return {
    businessKey: key,
    change: changed ? "replaced" : "identical",
    titleChanged,
    recapChanged,
    segmentDiffs,
  };
}

/**
 * 生成导入计划。dry-run 与真实导入必须走同一份计划，
 * 否则 admin 在预览里看到的和实际发生的会是两件事。
 */
export function planBundleImport(
  bundle: AdventureBundle,
  existing: ExistingEpisodeForImport[],
): ImportPlan {
  const existingByKey = new Map(
    existing.map((item) => [episodeKey(item), item]),
  );

  const incomingCounts = new Map<string, number>();
  for (const episode of bundle.episodes) {
    const key = episodeKey(episode);
    incomingCounts.set(key, (incomingCounts.get(key) ?? 0) + 1);
  }

  const items: ImportEpisodePlan[] = bundle.episodes.map((episode) => {
    const key = episodeKey(episode);
    const incomingHash = episodeContentHash(episode);
    const target = existingByKey.get(key);

    if ((incomingCounts.get(key) ?? 0) > 1) {
      return {
        businessKey: key,
        action: "reject" as const,
        incomingHash,
        existingHash: target?.currentContentHash ?? null,
        reason: `bundle 内业务键 ${key} 出现多次，无法判断该导入哪一份；请在导出前去掉重复。`,
      };
    }
    if (!target) {
      return {
        businessKey: key,
        action: "add" as const,
        incomingHash,
        existingHash: null,
        diff: diffEpisodes(null, episode),
      };
    }
    if (target.retiredAt) {
      const when =
        target.retiredAt instanceof Date
          ? target.retiredAt.toISOString()
          : String(target.retiredAt);
      return {
        businessKey: key,
        action: "reject" as const,
        incomingHash,
        existingHash: target.currentContentHash,
        episodeId: target.id,
        reason: `目标集已 retire（${when}）。retire 是内容方的显式下线决定，导入不得静默覆盖；请先 restore 再导入。`,
      };
    }
    if (
      target.currentContentHash &&
      target.currentContentHash === incomingHash
    ) {
      return {
        businessKey: key,
        action: "already_up_to_date" as const,
        incomingHash,
        existingHash: target.currentContentHash,
        episodeId: target.id,
      };
    }
    return {
      businessKey: key,
      action: "replace" as const,
      incomingHash,
      existingHash: target.currentContentHash,
      episodeId: target.id,
      diff: diffEpisodes(target.currentEpisode ?? null, episode),
    };
  });

  const count = (action: ImportAction) =>
    items.filter((item) => item.action === action).length;

  return {
    ok: count("reject") === 0,
    bundleHash: bundleContentHash(bundle),
    items,
    adds: count("add"),
    replaces: count("replace"),
    upToDate: count("already_up_to_date"),
    rejects: count("reject"),
  };
}
