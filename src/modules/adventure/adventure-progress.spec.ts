import {
  buildClosedEpisodeIds,
  CLOSED_PROGRESS_STATUSES,
  EXITABLE_PROGRESS_STATUSES,
  isClosedStatus,
  isExitableStatus,
  isReassignableStatus,
  REASSIGNABLE_PROGRESS_STATUSES,
  selectFirstPlayableEpisode,
} from "./adventure-progress";

describe("adventure-progress 状态判定", () => {
  it("exitable：in_progress/awaiting_reply/exited 可接管", () => {
    expect(isExitableStatus("in_progress")).toBe(true);
    expect(isExitableStatus("awaiting_reply")).toBe(true);
    expect(isExitableStatus("exited")).toBe(true);
    expect(isExitableStatus("completed")).toBe(false);
    expect(isExitableStatus("abandoned")).toBe(false);
    expect(isExitableStatus("failed_over")).toBe(false);
  });

  it("closed：completed/abandoned 是终态", () => {
    expect(isClosedStatus("completed")).toBe(true);
    expect(isClosedStatus("abandoned")).toBe(true);
    expect(isClosedStatus("in_progress")).toBe(false);
    expect(isClosedStatus("failed_over")).toBe(false);
  });

  it("reassignable：abandoned/failed_over 可重新分配", () => {
    expect(isReassignableStatus("abandoned")).toBe(true);
    expect(isReassignableStatus("failed_over")).toBe(true);
    expect(isReassignableStatus("exited")).toBe(false);
    expect(isReassignableStatus("in_progress")).toBe(false);
  });

  it("状态常量与判定函数口径一致", () => {
    expect(EXITABLE_PROGRESS_STATUSES.every(isExitableStatus)).toBe(true);
    expect(CLOSED_PROGRESS_STATUSES.every(isClosedStatus)).toBe(true);
    expect(REASSIGNABLE_PROGRESS_STATUSES.every(isReassignableStatus)).toBe(
      true,
    );
  });
});

describe("buildClosedEpisodeIds", () => {
  const progresses = [
    { episodeId: "ep1", status: "completed" },
    { episodeId: "ep2", status: "abandoned" },
    { episodeId: "ep3", status: "in_progress" },
    { episodeId: "ep4", status: "failed_over" },
  ];

  it("收集终态集 id，忽略非终态", () => {
    const ids = buildClosedEpisodeIds(progresses);
    expect(ids.has("ep1")).toBe(true);
    expect(ids.has("ep2")).toBe(true);
    expect(ids.has("ep3")).toBe(false);
    expect(ids.has("ep4")).toBe(false);
  });

  it("附加明确排除的集 id", () => {
    const ids = buildClosedEpisodeIds(progresses, "ep5");
    expect(ids.has("ep5")).toBe(true);
  });
});

describe("selectFirstPlayableEpisode", () => {
  const episodes = [
    { id: "ep1", retiredAt: null, published: true },
    { id: "ep2", retiredAt: new Date(), published: true },
    { id: "ep3", retiredAt: null, published: true },
    { id: "ep4", retiredAt: null, published: false },
  ];

  it("跳过 closed 与已 retire 的集，选第一个可播", () => {
    const closed = new Set(["ep1"]);
    expect(selectFirstPlayableEpisode(episodes, closed)?.id).toBe("ep3");
  });

  it("跳过未发布集之后无更后面的集时返回 null", () => {
    const closed = new Set(["ep1", "ep2"]);
    // ep3 可播但 ep4 未发布；ep3 在 ep4 之前，仍可选 ep3
    expect(selectFirstPlayableEpisode(episodes, closed)?.id).toBe("ep3");
  });

  it("第一个候选即未发布时返回 null（不跳过它去播后面的集）", () => {
    const onlyUnpublishedFirst = [
      { id: "epA", retiredAt: null, published: false },
      { id: "epB", retiredAt: null, published: true },
    ];
    expect(
      selectFirstPlayableEpisode(onlyUnpublishedFirst, new Set()),
    ).toBeNull();
  });

  it("全部 closed 时返回 null", () => {
    const closed = new Set(["ep1", "ep3"]);
    expect(selectFirstPlayableEpisode(episodes, closed)).toBeNull();
  });
});
