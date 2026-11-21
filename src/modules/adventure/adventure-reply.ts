/**
 * 冒险回复与互动的纯逻辑：交互元信息、当前交互点定位、二选一命中封装、
 * 开场 recap 行、二选一 LLM 开关解析。
 * 从 AdventureService 抽出，无 this 状态，供独立单测。
 */
import type { AdventureReply, PlayableSegment } from "./adventure.service";

/**
 * 把交互点的类型与段号盖到回复上，供 recordPresented 写进 result 事件。
 * 四种交互类型共用同一批 result 事件名，不带类型就无法把「二选一兜底率」
 * 的分母从开放提问里摘出来。interaction 为空（超时路径拿不到当前段）时原样返回。
 */
export function withInteractionMeta(
  reply: AdventureReply,
  interaction: PlayableSegment | null | undefined,
): AdventureReply {
  if (!interaction) {
    return reply;
  }
  return {
    ...reply,
    interaction: {
      type: interaction.interactionType ?? "unknown",
      order: interaction.order,
    },
  };
}

/** 当前等待回答的交互点（已播，order = nextSegmentOrder - 1）；非交互段一律不认。 */
export function findCurrentInteraction(
  progress: { nextSegmentOrder: number },
  segments: PlayableSegment[],
): PlayableSegment | undefined {
  return segments.find(
    (s) =>
      s.order === progress.nextSegmentOrder - 1 && s.kind === "interaction",
  );
}

/** 开场前情回顾的文本行：空 recap 返回空数组。 */
export function toRecapLines(recap: string | null): string[] {
  return recap ? [recap] : [];
}

/** 二选一 LLM 兜底开关解析：非字面 false/0 一律视为开；未配置回落默认值。 */
export function resolveChoiceLlmEnabled(
  raw: string | undefined,
  defaultEnabled: boolean,
): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultEnabled;
  }
  const normalized = String(raw).trim().toLowerCase();
  return normalized !== "false" && normalized !== "0";
}

/**
 * 二选一命中信息封装：命中第几个选项、判定来源（确定性/LLM）、
 * 该选项的作者内部 key、所在段 order、以及命中时锁定的版本快照 id。
 */
export function buildMatchedChoice(params: {
  index: number;
  source: "deterministic" | "llm";
  choices: ReadonlyArray<{ key?: string | null }>;
  segmentOrder: number;
  episodeVersionId: string | null;
}): NonNullable<AdventureReply["matchedChoice"]> {
  return {
    index: params.index,
    source: params.source,
    key: params.choices[params.index]?.key ?? null,
    segmentOrder: params.segmentOrder,
    episodeVersionId: params.episodeVersionId,
  };
}
