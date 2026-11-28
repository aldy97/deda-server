import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AdventureVideoService,
  payloadCharCount,
} from "./adventure-video.service";
import {
  resolveVideoStudioConfig,
  type VideoStudioConfig,
} from "@/config/video.config";

const ACTOR = { username: "xiong", displayName: "熊总", profile: "authoring" };
const REASON = "给这一集做一支 60 秒预告，用于投放测试";

function buildConfig(
  overrides: Partial<VideoStudioConfig> = {},
): VideoStudioConfig {
  return {
    ...resolveVideoStudioConfig(() => undefined),
    enabled: true,
    ...overrides,
  };
}

function buildEpisode(overrides: Record<string, unknown> = {}) {
  return {
    id: "ep1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 3,
    published: true,
    retiredAt: null,
    currentVersionId: "v1",
    ...overrides,
  };
}

function buildVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: "v1",
    status: "published",
    contentHash: "hash-v1",
    payload: {
      title: "星星湖",
      segments: [
        { kind: "narration", text: "小象沿着湖边慢慢走。" },
        { kind: "interaction", text: "你愿意和我一起找星星吗？" },
      ],
    },
    ...overrides,
  };
}

function makeService(configOverrides: Partial<VideoStudioConfig> = {}) {
  const prisma = {
    adventureVideoJob: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    adventureEpisode: { findUnique: jest.fn() },
    adventureEpisodeVersion: { findUnique: jest.fn() },
    adventureVideoVoice: { findMany: jest.fn().mockResolvedValue([]) },
    adventureContentAuditLog: { create: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const config = {
    get: jest.fn(() => buildConfig(configOverrides)),
  } as unknown as ConfigService;
  const service = new AdventureVideoService(prisma as never, config);
  return { service, prisma, config };
}

const DTO = {
  episodeId: "ep1",
  episodeVersionId: "v1",
  requestId: "req-12345678",
  reason: REASON,
};

describe("AdventureVideoService", () => {
  it("开关关闭时拒绝创建，不触达数据库", async () => {
    const { service, prisma } = makeService({ enabled: false });
    await expect(service.create("ep1", DTO, ACTOR)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.adventureVideoJob.findUnique).not.toHaveBeenCalled();
  });

  it("理由不足 8 个字直接拒绝", async () => {
    const { service } = makeService();
    await expect(
      service.create("ep1", { ...DTO, reason: "太短" }, ACTOR),
    ).rejects.toMatchObject({ response: { code: "REASON_REQUIRED" } });
  });

  it("同一 requestId 重复点击返回已有作业，不重复建单", async () => {
    const { service, prisma } = makeService();
    const existing = { id: "job1", episodeId: "ep1", status: "queued" };
    prisma.adventureVideoJob.findUnique.mockResolvedValue(existing);

    const result = await service.create("ep1", DTO, ACTOR);
    expect(result).toEqual({ job: existing, reused: true });
    expect(prisma.adventureVideoJob.create).not.toHaveBeenCalled();
  });

  it("requestId 被另一集占用时拒绝", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue({
      id: "job1",
      episodeId: "other",
    });
    await expect(service.create("ep1", DTO, ACTOR)).rejects.toMatchObject({
      response: { code: "REQUEST_ID_CONFLICT" },
    });
  });

  it("集不存在返回 404", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    prisma.adventureEpisode.findUnique.mockResolvedValue(null);
    await expect(service.create("ep1", DTO, ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("已下架 / 未发布 / 版本不是当前版，分别给出领域码", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ retiredAt: new Date() }, "EPISODE_RETIRED"],
      [{ published: false }, "EPISODE_NOT_PUBLISHED"],
      [{ currentVersionId: "v0" }, "VERSION_NOT_CURRENT"],
    ];
    for (const [override, code] of cases) {
      const { service, prisma } = makeService();
      prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
      prisma.adventureEpisode.findUnique.mockResolvedValue(
        buildEpisode(override as never),
      );
      await expect(service.create("ep1", DTO, ACTOR)).rejects.toMatchObject({
        response: { code },
      });
    }
  });

  it("预算超限时拒绝，并回报预估金额与预算", async () => {
    const { service, prisma } = makeService({ budgetCents: 100 });
    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    prisma.adventureEpisode.findUnique.mockResolvedValue(buildEpisode());
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());

    await expect(service.create("ep1", DTO, ACTOR)).rejects.toMatchObject({
      response: {
        code: "BUDGET_EXCEEDED",
        estimatedCostCents: 3655,
        budgetCents: 100,
      },
    });
    expect(prisma.adventureVideoJob.create).not.toHaveBeenCalled();
  });

  it("成功建单：绑定版本/hash/音色指纹，并写审计", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    prisma.adventureEpisode.findUnique.mockResolvedValue(buildEpisode());
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    const created = { id: "job1", status: "queued" };
    prisma.adventureVideoJob.create.mockResolvedValue(created);
    prisma.adventureContentAuditLog.create.mockResolvedValue({});

    const result = await service.create("ep1", DTO, ACTOR);

    expect(result).toEqual({ job: created, reused: false });
    expect(prisma.adventureVideoJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        episodeId: "ep1",
        episodeVersionId: "v1",
        contentHash: "hash-v1",
        businessKey: "elly/1/3",
        status: "queued",
        stage: "queued",
        aspect: "9:16",
        resolution: "720P",
        ttsMode: "system",
        requestId: "req-12345678",
        createdBy: "xiong",
      }),
    });
    expect(
      prisma.adventureVideoJob.create.mock.calls[0][0].data.voiceSetVersion,
    ).toMatch(/^system:/);
    expect(prisma.adventureContentAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "video_generate",
        entityType: "episode_version",
        businessKey: "elly/1/3",
        actorUsername: "xiong",
        reason: REASON,
      }),
    });
  });

  it("复刻模式三条音色不齐时拒绝，不产生任何费用", async () => {
    const { service, prisma } = makeService({ ttsMode: "cloned" });
    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    prisma.adventureEpisode.findUnique.mockResolvedValue(buildEpisode());
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    prisma.adventureVideoVoice.findMany.mockResolvedValue([
      { role: "elly", status: "ready", voiceId: "c1" },
    ]);

    await expect(service.create("ep1", DTO, ACTOR)).rejects.toMatchObject({
      response: { code: "VOICE_NOT_READY" },
    });
  });

  it("重试只接受 failed / canceled", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue({
      id: "job1",
      status: "running",
      episodeId: "ep1",
      episodeVersionId: "v1",
      businessKey: "elly/1/3",
      attempts: 0,
    });
    await expect(service.retry("job1", ACTOR, REASON)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("取消只接受排队中 / 运行中", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue({
      id: "job1",
      status: "succeeded",
      episodeId: "ep1",
      episodeVersionId: "v1",
      businessKey: "elly/1/3",
    });
    await expect(service.cancel("job1", ACTOR, REASON)).rejects.toMatchObject({
      response: { code: "JOB_NOT_CANCELABLE" },
    });
  });
});

describe("payloadCharCount", () => {
  it("只统计 segments.text", () => {
    expect(
      payloadCharCount({
        segments: [{ text: "abc" }, { text: "de" }, {}],
      }),
    ).toBe(5);
  });

  it("结构异常按 0 处理", () => {
    expect(payloadCharCount(null)).toBe(0);
    expect(payloadCharCount({})).toBe(0);
    expect(payloadCharCount({ segments: "x" })).toBe(0);
  });
});
