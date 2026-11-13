import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureService } from "./adventure.service";
import {
  ADVENTURE_RECOVERY_ALERT_MARKER,
  ADVENTURE_SWEEP_HISTORY_LIMIT,
} from "./adventure.constants";
import { AdventureCircuitBreaker } from "./adventure-circuit-breaker.service";
import { AdventureRecoveryService } from "./adventure-recovery.service";

/**
 * 巡检的每个 detector 都必须有一正一反两条用例：
 * 正向证明病态被处置，反向证明**健康行绝不被误伤**——
 * 巡检改的是真在玩的孩子的状态，误伤比漏检严重得多。
 */

const TODAY = "2026-11-13";

function makeEpisode(overrides: Record<string, unknown> = {}) {
  return {
    id: "ep-1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
    title: "第一集",
    recap: null,
    published: true,
    retiredAt: null,
    currentVersionId: "ver-1",
    ...overrides,
  };
}

function makeProgress(overrides: Record<string, unknown> = {}) {
  return {
    id: "prog-1",
    deviceId: "dev-1",
    episodeId: "ep-1",
    nextSegmentOrder: 1,
    episodeVersionId: "ver-1",
    status: "awaiting_reply",
    waitingSince: null,
    stars: 0,
    offTopicCount: 0,
    completedAt: null,
    createdAt: new Date("2026-11-13T08:00:00.000Z"),
    updatedAt: new Date("2026-11-13T08:00:00.000Z"),
    ...overrides,
  };
}

function makeDaily(overrides: Record<string, unknown> = {}) {
  return {
    id: "daily-1",
    deviceId: "dev-1",
    episodeId: "ep-1",
    assignedDate: TODAY,
    status: "in_progress",
    assignedAt: new Date("2026-11-13T08:00:00.000Z"),
    completedAt: null,
    completedDate: null,
    ...overrides,
  };
}

/** 三段旁白 + 一个互动点的正常版本快照 */
const HEALTHY_PAYLOAD = {
  title: "第一集",
  recap: null,
  segments: [
    { order: 0, kind: "narration", text: "开场" },
    {
      order: 1,
      kind: "interaction",
      text: "你要走哪条路？",
      interactionType: "two_choice",
      options: {
        choices: [
          { key: "a", text: "左边", reply: "走左边" },
          { key: "b", text: "右边", reply: "走右边" },
        ],
      },
    },
    { order: 2, kind: "narration", text: "结尾" },
  ],
};

/** 与 HEALTHY_PAYLOAD 一致的物化副本：发布动作会同时写这两处，
 *  默认铺上它，detector 7（漂移）才不会在不关心漂移的用例里报噪声。 */
const HEALTHY_TABLE = HEALTHY_PAYLOAD.segments.map((segment) => ({
  order: segment.order,
  kind: segment.kind,
  text: segment.text,
}));

interface Harness {
  service: AdventureRecoveryService;
  prisma: {
    adventureProgress: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    adventureDailyRecord: { findMany: jest.Mock; update: jest.Mock };
    adventureEpisodeVersion: { findUnique: jest.Mock };
    adventureSegment: { findMany: jest.Mock };
  };
  breaker: { recordFailure: jest.Mock; getState: jest.Mock; reset: jest.Mock };
  adventure: { registerFailureListener: jest.Mock };
  listeners: Array<(report: unknown) => void | Promise<void>>;
}

function build(env: Record<string, string> = {}): Harness {
  const prisma = {
    adventureProgress: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockImplementation(async ({ data }) => data),
    },
    adventureDailyRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(async ({ data }) => data),
    },
    adventureEpisodeVersion: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    adventureSegment: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const breaker = {
    recordFailure: jest.fn().mockResolvedValue({ tripped: false }),
    getState: jest.fn().mockResolvedValue({ enabled: true, tripped: false }),
    reset: jest.fn().mockResolvedValue(undefined),
  };
  const listeners: Array<(report: unknown) => void | Promise<void>> = [];
  const adventure = {
    registerFailureListener: jest.fn((listener) => {
      listeners.push(listener);
    }),
  };
  const configService = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;

  const service = new AdventureRecoveryService(
    prisma as unknown as PrismaService,
    configService,
    adventure as unknown as AdventureService,
    breaker as unknown as AdventureCircuitBreaker,
  );
  return {
    service,
    prisma: prisma as unknown as Harness["prisma"],
    breaker,
    adventure: adventure as unknown as Harness["adventure"],
    listeners,
  };
}

/** 让 findMany 按模型返回不同结果集 */
function seed(
  h: Harness,
  opts: {
    progresses?: unknown[];
    dailies?: unknown[];
    versions?: Record<string, unknown>;
    segments?: Record<string, unknown[]>;
  },
) {
  h.prisma.adventureProgress.findMany.mockResolvedValue(opts.progresses ?? []);
  h.prisma.adventureDailyRecord.findMany.mockResolvedValue(opts.dailies ?? []);
  h.prisma.adventureEpisodeVersion.findUnique.mockImplementation(
    async ({ where }) => {
      const payload = (opts.versions ?? {})[where.id];
      return payload === undefined ? null : { id: where.id, payload };
    },
  );
  const table = opts.segments ?? { "ep-1": HEALTHY_TABLE };
  h.prisma.adventureSegment.findMany.mockImplementation(async ({ where }) => {
    return table[where.episodeId] ?? [];
  });
}

describe("AdventureRecoveryService", () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  const NOW = new Date("2026-11-13T09:00:00.000Z");

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockReturnValue(undefined);
    errorSpy = jest.spyOn(Logger.prototype, "error").mockReturnValue(undefined);
    jest.spyOn(Date, "now").mockReturnValue(NOW.getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("开关与生命周期", () => {
    it("enabled=false 时不注册失败监听、不启动定时器", () => {
      const h = build({ ADVENTURE_RECOVERY_ENABLED: "false" });
      jest.spyOn(global, "setInterval");
      h.service.onModuleInit();
      expect(h.adventure.registerFailureListener).not.toHaveBeenCalled();
      expect(setInterval).not.toHaveBeenCalled();
      h.service.onModuleDestroy();
    });

    it("默认开启时注册失败监听并启动 unref 过的定时器", () => {
      const h = build();
      const intervalSpy = jest.spyOn(global, "setInterval");
      h.service.onModuleInit();
      expect(h.adventure.registerFailureListener).toHaveBeenCalledTimes(1);
      expect(intervalSpy).toHaveBeenCalledTimes(1);
      expect(intervalSpy.mock.calls[0][1]).toBe(60_000);
      const timer = intervalSpy.mock.results[0].value as NodeJS.Timeout;
      expect(typeof timer.unref).toBe("function");
      h.service.onModuleDestroy();
    });

    it("巡检周期可被环境变量覆盖", () => {
      const h = build({ ADVENTURE_RECOVERY_SWEEP_INTERVAL_MS: "5000" });
      const intervalSpy = jest.spyOn(global, "setInterval");
      h.service.onModuleInit();
      expect(intervalSpy.mock.calls[0][1]).toBe(5000);
      h.service.onModuleDestroy();
    });

    it("enabled=false 时手动巡检也被 kill switch 拦住，并说明原因", async () => {
      const h = build({ ADVENTURE_RECOVERY_ENABLED: "false" });
      const report = await h.service.sweepBrokenProgress();
      expect(report.skipped).toBe(true);
      expect(report.reason).toContain("ADVENTURE_RECOVERY_ENABLED");
      expect(h.prisma.adventureProgress.findMany).not.toHaveBeenCalled();
    });
  });

  describe("detector 1：陈旧等待态（默认关闭）", () => {
    // nextSegmentOrder=2：锁定版本里 order=1 正是互动点，
    // 这样 detector 2 不会抢跑，测到的才是「陈旧等待态」本身。
    const stale = () =>
      makeProgress({
        status: "awaiting_reply",
        waitingSince: null,
        nextSegmentOrder: 2,
        updatedAt: new Date(NOW.getTime() - 600_000),
      });

    it("默认 off：主链路正常停在互动点的行完全不被扫描、不被处置", async () => {
      const h = build();
      seed(h, {
        progresses: [{ ...stale(), episode: makeEpisode() }],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
      expect(report.alerts).toEqual([]);
      expect(h.prisma.adventureProgress.update).not.toHaveBeenCalled();
    });

    it("alert：只告警不改状态", async () => {
      const h = build({ ADVENTURE_RECOVERY_STALE_AWAIT_ACTION: "alert" });
      seed(h, {
        progresses: [{ ...stale(), episode: makeEpisode() }],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
      expect(report.alerts.map((a) => a.code)).toContain(
        "STALE_AWAITING_REPLY",
      );
      expect(h.prisma.adventureProgress.update).not.toHaveBeenCalled();
    });

    it("exit：改判 exited，孩子当日再开口可从原处续玩", async () => {
      const h = build({ ADVENTURE_RECOVERY_STALE_AWAIT_ACTION: "exit" });
      seed(h, {
        progresses: [{ ...stale(), episode: makeEpisode() }],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toHaveLength(1);
      expect(report.repairs[0]).toMatchObject({
        code: "STALE_AWAITING_REPLY",
        to: "exited",
      });
      expect(h.prisma.adventureProgress.update).toHaveBeenCalledWith({
        where: { id: "prog-1" },
        data: { status: "exited", waitingSince: null },
      });
    });

    it("未超过陈旧阈值时即使是 alert 模式也不报", async () => {
      const h = build({ ADVENTURE_RECOVERY_STALE_AWAIT_ACTION: "alert" });
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              status: "awaiting_reply",
              waitingSince: null,
              nextSegmentOrder: 2,
              updatedAt: new Date(NOW.getTime() - 1000),
            }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts).toEqual([]);
    });

    it("waitingSince 已落的行由引擎自身的 10s 超时扫描负责，巡检不插手", async () => {
      const h = build({ ADVENTURE_RECOVERY_STALE_AWAIT_ACTION: "exit" });
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              status: "awaiting_reply",
              nextSegmentOrder: 2,
              waitingSince: new Date(NOW.getTime() - 600_000),
            }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
    });
  });

  describe("detector 2：等待态但锁定版本里下一段不是互动点", () => {
    it("交互点被新版本换型 → 改判 exited 并告警", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "awaiting_reply", nextSegmentOrder: 2 }),
            episode: makeEpisode(),
          },
        ],
        // 锁定版本里 order=1 是旁白，不是 interaction：孩子的回答永远接不住
        versions: {
          "ver-1": {
            segments: [
              { order: 0, kind: "narration", text: "a" },
              { order: 1, kind: "narration", text: "b" },
              { order: 2, kind: "narration", text: "c" },
            ],
          },
        },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toHaveLength(1);
      expect(report.repairs[0].code).toBe("AWAITING_NON_INTERACTION");
      expect(report.repairs[0].to).toBe("exited");
      expect(report.alerts.map((a) => a.code)).toContain(
        "AWAITING_NON_INTERACTION",
      );
    });

    it("正常停在互动点的行不被处置", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "awaiting_reply", nextSegmentOrder: 2 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
      expect(report.alerts).toEqual([]);
    });

    it("nextSegmentOrder=0 却在等待态（从未播过就等回答）同样改判 exited", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "awaiting_reply", nextSegmentOrder: 0 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs.map((r) => r.code)).toEqual([
        "AWAITING_NON_INTERACTION",
      ]);
    });
  });

  describe("detector 3：锁定版本行缺失或 payload 损坏", () => {
    it("版本行不存在 → 仅告警，绝不改写 pin（改写等于让孩子中途换版本）", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "in_progress", nextSegmentOrder: 1 }),
            episode: makeEpisode(),
          },
        ],
        versions: {},
        segments: {
          "ep-1": [
            { order: 0, kind: "narration", text: "a" },
            { order: 1, kind: "narration", text: "b" },
          ],
        },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts.map((a) => a.code)).toContain("VERSION_ROW_MISSING");
      expect(report.repairs).toEqual([]);
      expect(h.prisma.adventureProgress.update).not.toHaveBeenCalled();
    });

    it("payload 结构不可用 → 仅告警", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "in_progress", nextSegmentOrder: 1 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": { nope: true } },
        segments: {
          "ep-1": [
            { order: 0, kind: "narration", text: "a" },
            { order: 1, kind: "narration", text: "b" },
          ],
        },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts.map((a) => a.code)).toContain(
        "VERSION_PAYLOAD_UNUSABLE",
      );
      expect(report.repairs).toEqual([]);
    });

    it("未 pin 版本的历史进度（episodeVersionId 为空）不算病态", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              status: "in_progress",
              nextSegmentOrder: 1,
              episodeVersionId: null,
            }),
            episode: makeEpisode(),
          },
        ],
        segments: {
          "ep-1": [
            { order: 0, kind: "narration", text: "a" },
            { order: 1, kind: "narration", text: "b" },
          ],
        },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts).toEqual([]);
    });
  });

  describe("detector 4：进度指针越过段落末尾", () => {
    it("等待态越界 → 改判 exited（孩子永远等不到下一句）", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "awaiting_reply", nextSegmentOrder: 9 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs.map((r) => r.code)).toEqual([
        "SEGMENT_ORDER_OVERFLOW",
      ]);
      expect(report.repairs[0].to).toBe("exited");
    });

    it("在播态越界 → 仅告警（playFrom 的 isDone 会自然收口，巡检不抢跑）", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "in_progress", nextSegmentOrder: 9 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
      expect(report.alerts.map((a) => a.code)).toContain(
        "SEGMENT_ORDER_OVERFLOW",
      );
    });

    it("指针正好等于段数（刚播完最后一段）不算越界", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "in_progress", nextSegmentOrder: 3 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
      expect(report.alerts).toEqual([]);
    });

    it("同一行越界且等待态时只处置一次，不会重复改状态", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "awaiting_reply", nextSegmentOrder: 99 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toHaveLength(1);
      expect(h.prisma.adventureProgress.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("detector 5：daily 与 progress 状态打架", () => {
    it("progress 已完成但 daily 仍 in_progress → daily 收口为 completed 并补完集日", async () => {
      const h = build();
      seed(h, {
        dailies: [{ ...makeDaily(), episode: makeEpisode() }],
        progresses: [],
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({
          status: "completed",
          completedAt: new Date("2026-11-13T08:30:00.000Z"),
        }),
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toHaveLength(1);
      expect(report.repairs[0].code).toBe("DAILY_PROGRESS_STATE_CONFLICT");
      expect(h.prisma.adventureDailyRecord.update).toHaveBeenCalledWith({
        where: { id: "daily-1" },
        data: {
          status: "completed",
          completedAt: new Date("2026-11-13T08:30:00.000Z"),
          completedDate: TODAY,
        },
      });
    });

    it("补完集日必须用 progress 的实际完集日，否则昨天的完集会吃掉今天的额度", async () => {
      const h = build();
      seed(h, {
        dailies: [
          {
            ...makeDaily({ assignedDate: "2026-11-12" }),
            episode: makeEpisode(),
          },
        ],
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({
          status: "completed",
          completedAt: new Date("2026-11-12T10:00:00.000Z"),
        }),
      );
      await h.service.sweepBrokenProgress();
      expect(h.prisma.adventureDailyRecord.update).toHaveBeenCalledWith({
        where: { id: "daily-1" },
        data: {
          status: "completed",
          completedAt: new Date("2026-11-12T10:00:00.000Z"),
          completedDate: "2026-11-12",
        },
      });
    });

    it("progress 被 abandoned 收走 → daily 同步 abandoned，不带完集日", async () => {
      const h = build();
      seed(h, {
        dailies: [
          {
            ...makeDaily({ assignedDate: "2026-11-12" }),
            episode: makeEpisode(),
          },
        ],
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({ status: "abandoned" }),
      );
      await h.service.sweepBrokenProgress();
      expect(h.prisma.adventureDailyRecord.update).toHaveBeenCalledWith({
        where: { id: "daily-1" },
        data: { status: "abandoned" },
      });
    });

    it("两边都是 in_progress 的正常行不动", async () => {
      const h = build();
      seed(h, {
        dailies: [{ ...makeDaily(), episode: makeEpisode() }],
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({ status: "in_progress" }),
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
      expect(h.prisma.adventureDailyRecord.update).not.toHaveBeenCalled();
    });
  });

  describe("detector 6：retire 之后跨天卡死的 daily（retire 的真根因）", () => {
    it("昨天的 in_progress daily 指向已 retire 的集 → daily 与 progress 双双 abandoned", async () => {
      const h = build();
      seed(h, {
        dailies: [
          {
            ...makeDaily({ assignedDate: "2026-11-12" }),
            episode: makeEpisode({
              retiredAt: new Date("2026-11-12T10:00:00Z"),
            }),
          },
        ],
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({ status: "in_progress" }),
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs.map((r) => r.code)).toContain(
        "RETIRED_STALE_DAILY",
      );
      expect(h.prisma.adventureDailyRecord.update).toHaveBeenCalledWith({
        where: { id: "daily-1" },
        data: { status: "abandoned" },
      });
      expect(h.prisma.adventureProgress.update).toHaveBeenCalledWith({
        where: { id: "prog-1" },
        data: { status: "abandoned", waitingSince: null },
      });
    });

    it("今天分配给已 retire 集的 daily 不动：retire 刻意不打断当日在播的孩子", async () => {
      const h = build();
      seed(h, {
        dailies: [
          {
            ...makeDaily({ assignedDate: TODAY }),
            episode: makeEpisode({
              retiredAt: new Date("2026-11-13T08:10:00Z"),
            }),
          },
        ],
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({ status: "in_progress" }),
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
    });

    it("跨天但集没 retire 的 daily 不动（未完成集跨天保留是既定产品语义）", async () => {
      const h = build();
      seed(h, {
        dailies: [
          {
            ...makeDaily({ assignedDate: "2026-11-12" }),
            episode: makeEpisode(),
          },
        ],
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({ status: "in_progress" }),
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toEqual([]);
    });
  });

  describe("detector 7：segments 表与当前发布版漂移", () => {
    it("物化副本段数与发布版不一致 → 仅告警（重建是发布动作的职责）", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              status: "in_progress",
              nextSegmentOrder: 1,
              episodeVersionId: null,
            }),
            episode: makeEpisode({ currentVersionId: "ver-9" }),
          },
        ],
        versions: { "ver-9": HEALTHY_PAYLOAD },
        segments: { "ep-1": [{ order: 0, kind: "narration", text: "开场" }] },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts.map((a) => a.code)).toContain("SEGMENT_TABLE_DRIFT");
      expect(report.repairs).toEqual([]);
    });

    it("物化副本与发布版一致时不告警", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              status: "in_progress",
              nextSegmentOrder: 1,
              episodeVersionId: null,
            }),
            episode: makeEpisode({ currentVersionId: "ver-9" }),
          },
        ],
        versions: { "ver-9": HEALTHY_PAYLOAD },
        segments: {
          "ep-1": HEALTHY_PAYLOAD.segments.map((s) => ({
            order: s.order,
            kind: s.kind,
            text: s.text,
          })),
        },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts).toEqual([]);
    });

    it("没有当前发布版的草稿集不做漂移比较", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              status: "in_progress",
              nextSegmentOrder: 1,
              episodeVersionId: null,
            }),
            episode: makeEpisode({ currentVersionId: null }),
          },
        ],
        segments: { "ep-1": [{ order: 0, kind: "narration", text: "开场" }] },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts).toEqual([]);
      expect(
        h.prisma.adventureEpisodeVersion.findUnique,
      ).not.toHaveBeenCalled();
    });
  });

  describe("detector 8：daily 指向玩不下去的进度", () => {
    it("daily 在飞但 progress 行不存在 → 仅告警（下次孩子开口即自愈）", async () => {
      const h = build();
      seed(h, { dailies: [{ ...makeDaily(), episode: makeEpisode() }] });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(null);
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts.map((a) => a.code)).toContain(
        "DAILY_WITHOUT_PLAYABLE_PROGRESS",
      );
      expect(report.repairs).toEqual([]);
    });

    it("daily 在飞但 progress 已被 failed_over 收走 → 仅告警，不改状态", async () => {
      const h = build();
      seed(h, { dailies: [{ ...makeDaily(), episode: makeEpisode() }] });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({ status: "failed_over" }),
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.alerts.map((a) => a.code)).toContain(
        "DAILY_WITHOUT_PLAYABLE_PROGRESS",
      );
      expect(report.repairs).toEqual([]);
      expect(h.prisma.adventureDailyRecord.update).not.toHaveBeenCalled();
    });
  });

  describe("隔离性与熔断", () => {
    it("一台设备的处置抛错不影响其他设备，错误进 report.errors", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              id: "prog-bad",
              deviceId: "dev-bad",
              status: "awaiting_reply",
              nextSegmentOrder: 99,
            }),
            episode: makeEpisode(),
          },
          {
            ...makeProgress({
              id: "prog-good",
              deviceId: "dev-good",
              status: "awaiting_reply",
              nextSegmentOrder: 99,
            }),
            episode: makeEpisode({ id: "ep-1" }),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      h.prisma.adventureProgress.update.mockImplementation(
        async ({ where }) => {
          if (where.id === "prog-bad") throw new Error("db write failed");
          return where;
        },
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.errors.some((e) => e.includes("db write failed"))).toBe(
        true,
      );
      expect(report.repairs.map((r) => r.progressId)).toEqual(["prog-good"]);
      // 处置失败必须落 error 日志：这是后台唯一能看见「巡检自己出错了」的地方
      expect(
        errorSpy.mock.calls.some((call) =>
          String(call[0]).includes("db write failed"),
        ),
      ).toBe(true);
    });

    it("一次巡检有多处修复时只向熔断器记一次失败", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({
              id: "p1",
              status: "awaiting_reply",
              nextSegmentOrder: 99,
            }),
            episode: makeEpisode(),
          },
          {
            ...makeProgress({
              id: "p2",
              deviceId: "dev-2",
              status: "awaiting_reply",
              nextSegmentOrder: 99,
            }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toHaveLength(2);
      expect(h.breaker.recordFailure).toHaveBeenCalledTimes(1);
    });

    it("巡检全绿时不向熔断器记失败", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "awaiting_reply", nextSegmentOrder: 2 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      await h.service.sweepBrokenProgress();
      expect(h.breaker.recordFailure).not.toHaveBeenCalled();
    });

    it("熔断器自己抛错也不影响巡检产出报告", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "awaiting_reply", nextSegmentOrder: 99 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      h.breaker.recordFailure.mockRejectedValue(new Error("redis down"));
      const report = await h.service.sweepBrokenProgress();
      expect(report.repairs).toHaveLength(1);
      expect(report.errors).toEqual([]);
    });

    it("告警日志带固定标记，供日志告警规则抓取", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "in_progress", nextSegmentOrder: 9 }),
            episode: makeEpisode(),
          },
        ],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      await h.service.sweepBrokenProgress();
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some((message) =>
          message.includes(ADVENTURE_RECOVERY_ALERT_MARKER),
        ),
      ).toBe(true);
    });
  });

  describe("引擎失败监听", () => {
    it("收到引擎失败上报后记入环形缓冲并计数到熔断器", async () => {
      const h = build();
      h.service.onModuleInit();
      const listener = h.listeners[0];
      await listener({
        deviceInternalId: "dev-1",
        phase: "handle_reply",
        reason: "boom",
        recovered: true,
        at: NOW.toISOString(),
      });
      expect(h.breaker.recordFailure).toHaveBeenCalledTimes(1);
      expect(String(h.breaker.recordFailure.mock.calls[0][0])).toContain(
        "handle_reply",
      );
      const snapshot = await h.service.getHealthSnapshot();
      expect(snapshot.engineFailures).toHaveLength(1);
      expect(snapshot.engineFailures[0]).toMatchObject({
        deviceId: "dev-1",
        phase: "handle_reply",
        recovered: true,
      });
      h.service.onModuleDestroy();
    });

    it("失败上报缓冲有上限，不会无限涨内存", async () => {
      const h = build();
      h.service.onModuleInit();
      const listener = h.listeners[0];
      for (let i = 0; i < 80; i++) {
        await listener({
          deviceInternalId: `dev-${i}`,
          phase: "start_today",
          reason: `boom-${i}`,
          recovered: false,
          at: NOW.toISOString(),
        });
      }
      const snapshot = await h.service.getHealthSnapshot();
      expect(snapshot.engineFailures.length).toBeLessThanOrEqual(50);
      expect(snapshot.engineFailures[0].reason).toBe("boom-79");
      h.service.onModuleDestroy();
    });

    it("监听器自身抛错不影响引擎（上报是尽力而为）", async () => {
      const h = build();
      h.breaker.recordFailure.mockRejectedValue(new Error("redis down"));
      h.service.onModuleInit();
      await expect(
        h.listeners[0]({
          deviceInternalId: "dev-1",
          phase: "check_timeout",
          reason: "boom",
          recovered: false,
          at: NOW.toISOString(),
        }),
      ).resolves.not.toThrow();
      h.service.onModuleDestroy();
    });
  });

  describe("报告与面板", () => {
    it("报告带扫描量、时间戳与耗时", async () => {
      const h = build();
      seed(h, {
        progresses: [
          {
            ...makeProgress({ status: "in_progress", nextSegmentOrder: 1 }),
            episode: makeEpisode(),
          },
        ],
        dailies: [{ ...makeDaily(), episode: makeEpisode() }],
        versions: { "ver-1": HEALTHY_PAYLOAD },
      });
      h.prisma.adventureProgress.findUnique.mockResolvedValue(
        makeProgress({ status: "in_progress" }),
      );
      const report = await h.service.sweepBrokenProgress();
      expect(report.scanned.progresses).toBe(1);
      expect(report.scanned.dailyRecords).toBe(1);
      expect(report.startedAt).toBeTruthy();
      expect(report.finishedAt).toBeTruthy();
      expect(typeof report.durationMs).toBe("number");
      expect(report.skipped).toBe(false);
    });

    it("巡检报告保留最近 N 份，最新的排在前面", async () => {
      const h = build();
      seed(h, {});
      for (let i = 0; i < ADVENTURE_SWEEP_HISTORY_LIMIT + 5; i++) {
        await h.service.sweepBrokenProgress();
      }
      const snapshot = await h.service.getHealthSnapshot();
      expect(snapshot.sweeps).toHaveLength(ADVENTURE_SWEEP_HISTORY_LIMIT);
      expect(
        new Date(snapshot.sweeps[0].finishedAt).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(snapshot.sweeps[1].finishedAt).getTime(),
      );
    });

    it("getHealthSnapshot 汇总熔断状态、生效阈值与最近巡检", async () => {
      const h = build({ ADVENTURE_RECOVERY_STALE_AWAIT_ACTION: "alert" });
      seed(h, {});
      h.breaker.getState.mockResolvedValue({
        enabled: true,
        tripped: true,
        failureCount: 7,
      });
      await h.service.sweepBrokenProgress();
      const snapshot = await h.service.getHealthSnapshot();
      expect(snapshot.breaker.tripped).toBe(true);
      expect(snapshot.config).toMatchObject({
        enabled: true,
        sweepIntervalMs: 60_000,
        staleAwaitMs: 120_000,
        staleAwaitAction: "alert",
        breakerWindowMs: 600_000,
        breakerThreshold: 5,
      });
      expect(snapshot.sweeps).toHaveLength(1);
    });
  });
});
