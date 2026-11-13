import { INestApplication } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { adventureDateKey } from "../src/modules/adventure/adventure-date.util";
import { AdventureCircuitBreaker } from "../src/modules/adventure/adventure-circuit-breaker.service";
import { AdventureRecoveryService } from "../src/modules/adventure/adventure-recovery.service";

dotenv.config();

/**
 * 自愈巡检的真库集成测试。
 *
 * 为什么单测（adventure-recovery.service.spec.ts，42 例）不够：那里的 Prisma 全是 mock，
 * 于是 8 个 detector 的查询与写入**从未对着真库跑过一次**。字段名拼错能被 tsc 拦住，
 * 但「Json 列读出来到底是什么形状」「completedDate 写进去是不是字符串」只有真库能回答。
 * 而这一层的失败模式是最坏的那种：巡检静默扫不动，后台一切正常，孩子那边依旧无限沉默。
 *
 * 三条纪律：
 * - 种子集一律 `published: false`。引擎选集只捞已发布且未 retire 的集，所以本套件的行
 *   永远不会被别的 e2e 分配给某个设备；而没有一个 detector 依赖 published，覆盖面不减。
 * - 种子进度的 `waitingSince` 一律为 null：引擎自身的 2s 超时扫描按
 *   `waitingSince <= now-10s` 过滤，null 不在其中，两套扫描不会互相踩。
 * - 共享测试库里有别的套件的行，所以对 `report.errors` 的断言只针对**本套件自己的 id**，
 *   不断言全局为空。afterAll 必须清干净，遗留的 in_progress daily 会干扰其它套件。
 */
describe("Adventure recovery sweep (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let recovery: AdventureRecoveryService;

  const runId = randomUUID().slice(0, 8);
  // @@unique([characterKey, season, episodeNumber])：用随机大集号与其它套件错开
  const episodeNumber = 100000 + (parseInt(runId.slice(0, 4), 16) % 800000);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterdayKey = adventureDateKey(yesterday);
  const todayKey = adventureDateKey();

  // @@unique([characterKey, season, episodeNumber])：每集必须错开集号
  let episodeOffset = 0;
  const episodeIds: string[] = [];
  const deviceIds: string[] = [];
  const progressIds: string[] = [];
  const dailyIds: string[] = [];

  type SeedSegment = {
    order: number;
    kind: string;
    text: string;
    interactionType?: string | null;
    options?: Prisma.InputJsonValue | null;
  };

  /** 一集三段：旁白 → 二选一互动点 → 旁白。segments 表与版本快照一致。 */
  async function seedEpisode(
    name: string,
    options: { retired?: boolean; driftText?: boolean } = {},
  ): Promise<{ episodeId: string; deviceId: string; versionId: string }> {
    const episode = await prisma.adventureEpisode.create({
      data: {
        characterKey: "elly",
        season: 1,
        episodeNumber: episodeNumber + episodeOffset++,
        title: `巡检种子-${name}`,
        recap: "前情回顾",
        published: false,
        retiredAt: options.retired ? new Date() : null,
      },
    });
    episodeIds.push(episode.id);

    const segments: SeedSegment[] = [
      { order: 0, kind: "narration", text: "今天 Elly 要去找银色铃铛。" },
      {
        order: 1,
        kind: "interaction",
        text: "我们去森林还是去河边？",
        interactionType: "two_choice",
        options: {
          choices: [
            { key: "a", text: "森林", reply: "好，我们去森林。" },
            { key: "b", text: "河边", reply: "好，我们去河边。" },
          ],
        },
      },
      { order: 2, kind: "narration", text: "他们找到了铃铛。" },
    ];
    await prisma.adventureSegment.createMany({
      data: segments.map((segment) => ({
        episodeId: episode.id,
        order: segment.order,
        kind: segment.kind,
        text:
          options.driftText && segment.order === 2
            ? "段落表里的文本与快照不同"
            : segment.text,
        interactionType: segment.interactionType ?? null,
        options: segment.options ?? Prisma.DbNull,
      })),
    });

    const version = await prisma.adventureEpisodeVersion.create({
      data: {
        episodeId: episode.id,
        version: 1,
        status: "published",
        // 快照存「发布时的原文」：driftText 时段落表被改过，两者不一致 → 触发 drift 告警
        payload: {
          title: `巡检种子-${name}`,
          recap: "前情回顾",
          segments: segments.map((segment) => ({
            order: segment.order,
            kind: segment.kind,
            text: segment.text,
            interactionType: segment.interactionType ?? null,
            options: segment.options ?? null,
          })),
        },
        createdBy: "e2e",
        createdByName: "e2e",
        publishedAt: new Date(),
      },
    });
    await prisma.adventureEpisode.update({
      where: { id: episode.id },
      data: { currentVersionId: version.id },
    });

    const device = await prisma.device.create({
      data: {
        deviceId: `rec-${runId}-${name}`,
        characterKey: "elly",
        // 刻意用一个又老又固定的时间：analytics-fleet 的断言是全局口径
        // （按 createdAt desc 取第一页、按 2026-07 的日期窗口聚合），
        // 并行跑时任何新建的设备都会串进它的结果。落在它的窗口之外就不添乱。
        createdAt: new Date("2026-01-05T00:00:00Z"),
      },
    });
    deviceIds.push(device.id);

    return {
      episodeId: episode.id,
      deviceId: device.id,
      versionId: version.id,
    };
  }

  async function seedProgress(
    seeded: { episodeId: string; deviceId: string; versionId: string },
    data: {
      status: string;
      nextSegmentOrder: number;
      completedAt?: Date;
    },
  ) {
    const progress = await prisma.adventureProgress.create({
      data: {
        deviceId: seeded.deviceId,
        episodeId: seeded.episodeId,
        nextSegmentOrder: data.nextSegmentOrder,
        episodeVersionId: seeded.versionId,
        status: data.status,
        completedAt: data.completedAt ?? null,
      },
    });
    progressIds.push(progress.id);
    return progress;
  }

  async function seedDaily(
    seeded: { episodeId: string; deviceId: string },
    data: { status: string; assignedDate: string },
  ) {
    const daily = await prisma.adventureDailyRecord.create({
      data: {
        deviceId: seeded.deviceId,
        episodeId: seeded.episodeId,
        assignedDate: data.assignedDate,
        status: data.status,
      },
    });
    dailyIds.push(daily.id);
    return daily;
  }

  beforeAll(async () => {
    process.env.REDIS_URL = "";
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    recovery = app.get(AdventureRecoveryService);
  }, 60000);

  afterAll(async () => {
    // AdventureEpisodeVersion 是 onDelete: Restrict，必须先删；其余随 episode/device 级联
    await prisma.adventureEpisodeVersion.deleteMany({
      where: { episodeId: { in: episodeIds } },
    });
    await prisma.adventureDailyRecord.deleteMany({
      where: { deviceId: { in: deviceIds } },
    });
    await prisma.adventureProgress.deleteMany({
      where: { deviceId: { in: deviceIds } },
    });
    await prisma.adventureSegment.deleteMany({
      where: { episodeId: { in: episodeIds } },
    });
    await prisma.adventureEpisode.deleteMany({
      where: { id: { in: episodeIds } },
    });
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
    await app.close();
  }, 60000);

  it("repairs every silent pathology it is allowed to touch, and leaves healthy rows alone", async () => {
    // detector 2：等待态指着一个旁白段（order=0），孩子的回答会被判成 null
    const awaitingNarration = await seedEpisode("await-narration");
    const p2 = await seedProgress(awaitingNarration, {
      status: "awaiting_reply",
      nextSegmentOrder: 1,
    });

    // detector 4：等待态 + 段号越界
    const overflow = await seedEpisode("overflow");
    const p4 = await seedProgress(overflow, {
      status: "awaiting_reply",
      nextSegmentOrder: 99,
    });

    // detector 5：daily 在飞但进度已 completed，且完集日是**昨天**
    const conflict = await seedEpisode("conflict");
    await seedProgress(conflict, {
      status: "completed",
      nextSegmentOrder: 3,
      completedAt: yesterday,
    });
    const d5 = await seedDaily(conflict, {
      status: "in_progress",
      assignedDate: yesterdayKey,
    });

    // detector 6：集已 retire + 昨天的 daily 仍 in_progress + 进度仍 in_progress
    const retired = await seedEpisode("retired", { retired: true });
    const p6 = await seedProgress(retired, {
      status: "in_progress",
      nextSegmentOrder: 1,
    });
    const d6 = await seedDaily(retired, {
      status: "in_progress",
      assignedDate: yesterdayKey,
    });

    // detector 8：daily 在飞但进度已被收走（failed_over）→ 只告警
    const reassignable = await seedEpisode("reassignable");
    await seedProgress(reassignable, {
      status: "failed_over",
      nextSegmentOrder: 1,
    });
    await seedDaily(reassignable, {
      status: "in_progress",
      assignedDate: todayKey,
    });

    // detector 7：段落表与发布快照不一致 → 只告警，绝不改内容
    const drifted = await seedEpisode("drift", { driftText: true });
    await seedProgress(drifted, {
      status: "in_progress",
      nextSegmentOrder: 1,
    });

    // 对照组 1：健康的等待态（正确停在互动点，waitingSince 为空）。
    // 主链路（百度 RTC）刻意不落 waitingSince，孩子可能一停几小时——
    // 默认 staleAwaitAction=off 时必须**一动不动**，否则冒险会在半路被巡检杀掉。
    const healthy = await seedEpisode("healthy");
    const pHealthy = await seedProgress(healthy, {
      status: "awaiting_reply",
      nextSegmentOrder: 2,
    });

    // 对照组 2：今天的 daily + 在播进度，一切正常
    await seedDaily(healthy, { status: "in_progress", assignedDate: todayKey });

    const report = await recovery.sweepBrokenProgress();

    expect(report.skipped).toBe(false);
    expect(report.scanned.progresses).toBeGreaterThanOrEqual(5);
    expect(report.scanned.dailyRecords).toBeGreaterThanOrEqual(4);

    const mine = [...progressIds, ...dailyIds, ...episodeIds, ...deviceIds];
    expect(
      report.errors.filter((line) => mine.some((id) => line.includes(id))),
    ).toEqual([]);

    const progressCodes = (id: string) =>
      report.repairs
        .filter(
          (repair) => repair.target === "progress" && repair.progressId === id,
        )
        .map((repair) => repair.code);
    const dailyCodes = (id: string) =>
      report.repairs
        .filter(
          (repair) => repair.target === "daily" && repair.dailyRecordId === id,
        )
        .map((repair) => repair.code);

    expect(progressCodes(p2.id)).toEqual(["AWAITING_NON_INTERACTION"]);
    expect(progressCodes(p4.id)).toEqual(["SEGMENT_ORDER_OVERFLOW"]);
    expect(dailyCodes(d5.id)).toEqual(["DAILY_PROGRESS_STATE_CONFLICT"]);
    expect(dailyCodes(d6.id)).toEqual(["RETIRED_STALE_DAILY"]);
    expect(progressCodes(p6.id)).toEqual(["RETIRED_STALE_DAILY"]);

    // 真库落盘校验：巡检说修了，库里必须真的变了
    const after2 = await prisma.adventureProgress.findUniqueOrThrow({
      where: { id: p2.id },
    });
    expect(after2.status).toBe("exited");
    expect(after2.waitingSince).toBeNull();

    const after4 = await prisma.adventureProgress.findUniqueOrThrow({
      where: { id: p4.id },
    });
    expect(after4.status).toBe("exited");

    // 完集日必须是 progress 里的昨天，绝不能写成今天（否则孩子白丢一天额度）
    const after5 = await prisma.adventureDailyRecord.findUniqueOrThrow({
      where: { id: d5.id },
    });
    expect(after5.status).toBe("completed");
    expect(after5.completedDate).toBe(yesterdayKey);
    expect(after5.completedDate).not.toBe(todayKey);

    const after6Daily = await prisma.adventureDailyRecord.findUniqueOrThrow({
      where: { id: d6.id },
    });
    const after6Progress = await prisma.adventureProgress.findUniqueOrThrow({
      where: { id: p6.id },
    });
    expect(after6Daily.status).toBe("abandoned");
    expect(after6Progress.status).toBe("abandoned");

    // 对照组：健康行一个字都没被改
    const healthyAfter = await prisma.adventureProgress.findUniqueOrThrow({
      where: { id: pHealthy.id },
    });
    expect(healthyAfter.status).toBe("awaiting_reply");
    expect(healthyAfter.nextSegmentOrder).toBe(2);
    expect(progressCodes(pHealthy.id)).toEqual([]);

    // 只告警不改的两个 detector 确实报了，且没有对应的 repair
    const alertCodes = report.alerts.map((alert) => alert.code);
    expect(alertCodes).toContain("DAILY_WITHOUT_PLAYABLE_PROGRESS");
    expect(alertCodes).toContain("SEGMENT_TABLE_DRIFT");
    expect(
      report.repairs.filter(
        (repair) =>
          repair.code === "SEGMENT_TABLE_DRIFT" ||
          repair.code === "DAILY_WITHOUT_PLAYABLE_PROGRESS",
      ),
    ).toEqual([]);

    // 漂移告警绝不伴随内容改写：段落表原文必须还在
    const driftedText = await prisma.adventureSegment.findFirstOrThrow({
      where: { episodeId: drifted.episodeId, order: 2 },
    });
    expect(driftedText.text).toBe("段落表里的文本与快照不同");
  }, 90000);

  it("is idempotent: a second sweep finds nothing new to change on these rows", async () => {
    const second = await recovery.sweepBrokenProgress();

    const touched = second.repairs.filter((repair) =>
      [...progressIds, ...dailyIds].some(
        (id) => repair.progressId === id || repair.dailyRecordId === id,
      ),
    );
    expect(touched).toEqual([]);
  }, 90000);

  it("refuses to run at all when the kill switch is off, even on explicit demand", async () => {
    const previous = process.env.ADVENTURE_RECOVERY_ENABLED;
    process.env.ADVENTURE_RECOVERY_ENABLED = "false";
    try {
      const report = await recovery.sweepBrokenProgress();

      expect(report.skipped).toBe(true);
      expect(report.reason).toContain("kill switch");
      expect(report.repairs).toEqual([]);
      expect(report.scanned).toEqual({
        progresses: 0,
        dailyRecords: 0,
        episodes: 0,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.ADVENTURE_RECOVERY_ENABLED;
      } else {
        process.env.ADVENTURE_RECOVERY_ENABLED = previous;
      }
    }
  }, 60000);

  it("keeps the breaker usable through the in-memory fallback, and a clean sweep records no failure", async () => {
    const breaker = app.get(AdventureCircuitBreaker);
    await breaker.reset();

    const before = (await recovery.getHealthSnapshot()).breaker;
    // e2e 把 REDIS_URL 置空：RedisService 降级为进程内 Map，zset 操作照样成功，
    // 所以熔断器是**可用的**（degraded=false）。degraded=true 只在 Redis 已配置
    // 却报错时出现——那种情况下熔断器故意不工作：宁可漏报，也不能因为读不到
    // 计数就把所有设备判成故障。
    expect(before.enabled).toBe(true);
    expect(before.degraded).toBe(false);
    expect(before.tripped).toBe(false);
    expect(before.failureCount).toBe(0);

    // 断言的是「干净巡检不新增失败」，而不是全局计数的绝对值：引擎自身的 2s
    // 超时扫描会并发处理测试库里别的遗留行，那属于进程级共享状态，不是本测试的对象。
    await recovery.sweepBrokenProgress();
    const after = (await recovery.getHealthSnapshot()).breaker;
    expect(after.failureCount).toBe(before.failureCount);
    expect(after.tripped).toBe(false);
    expect((await recovery.getHealthSnapshot()).config.staleAwaitAction).toBe(
      "off",
    );
  }, 60000);

  it("trips at the configured threshold and clears only on an explicit human reset", async () => {
    const breaker = app.get(AdventureCircuitBreaker);
    await breaker.reset();
    const { breakerThreshold } = (await recovery.getHealthSnapshot()).config;

    let last = await breaker.recordFailure("e2e 兜底失败 1");
    for (let index = 1; index < breakerThreshold; index += 1) {
      last = await breaker.recordFailure(`e2e 兜底失败 ${index + 1}`);
    }

    // 授权回滚：熔断只标记 + 告警，绝不自动改内容，也绝不自动解除
    expect(last.tripped).toBe(true);
    expect((await breaker.getState()).tripped).toBe(true);

    await recovery.resetBreaker();

    const cleared = await breaker.getState();
    expect(cleared.tripped).toBe(false);
    expect(cleared.failureCount).toBe(0);
  }, 60000);
});
