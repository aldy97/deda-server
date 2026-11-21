/**
 * 冒险进度状态机的纯判定与选集过滤。
 * 从 AdventureService 抽出，无 this 状态，供独立单测。
 */

/**
 * 允许被「不想玩了」接管的进度状态。
 * 终态一律不在其中：completed / abandoned 是「任何路径都不得覆盖」的进度终态，
 * failed_over 是这一集已被自愈收走。这三种情况下念「之后再一起继续冒险」是假承诺，
 * 所以不接管，让这句话掉回正常的意图路由。
 */
export const EXITABLE_PROGRESS_STATUSES = [
  "in_progress",
  "awaiting_reply",
  "exited",
];

/** 进度终态：选集时永久排除，且任何路径都不得覆盖 */
export const CLOSED_PROGRESS_STATUSES = ["completed", "abandoned"];

/** 已被收走、不再续玩的进度：落到选集重新分配（区别于 exited 的当日可续玩） */
export const REASSIGNABLE_PROGRESS_STATUSES = ["abandoned", "failed_over"];

export function isExitableStatus(status: string): boolean {
  return EXITABLE_PROGRESS_STATUSES.includes(status);
}

export function isClosedStatus(status: string): boolean {
  return CLOSED_PROGRESS_STATUSES.includes(status);
}

export function isReassignableStatus(status: string): boolean {
  return REASSIGNABLE_PROGRESS_STATUSES.includes(status);
}

/** 由进度行构建「不可再选」的集 id 集合：终态 + 明确排除的集。 */
export function buildClosedEpisodeIds(
  progresses: ReadonlyArray<{ episodeId: string; status: string }>,
  excludeEpisodeId?: string,
): Set<string> {
  const closed = new Set(
    progresses
      .filter((progress) => isClosedStatus(progress.status))
      .map((progress) => progress.episodeId),
  );
  if (excludeEpisodeId) {
    closed.add(excludeEpisodeId);
  }
  return closed;
}

/**
 * 按 episodeNumber 升序选出第一个可播集：跳过已 retire 的集与不可再选集。
 * 未发布的集是内容硬边界——宁可停播（返回 null），也不跳过它去播后面的集。
 */
export function selectFirstPlayableEpisode<
  T extends {
    id: string;
    retiredAt?: unknown;
    published?: boolean;
  },
>(episodes: T[], closedEpisodeIds: Set<string>): T | null {
  const episode = episodes.find(
    (item) => !closedEpisodeIds.has(item.id) && !item.retiredAt,
  );
  if (!episode || !episode.published) {
    return null;
  }
  return episode;
}
