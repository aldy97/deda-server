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
import {
  computeVoiceTextHash,
  type Storyboard,
} from "./storyboard/storyboard.types";

const ACTOR = { username: "xiong", displayName: "熊总", profile: "authoring" };
const REASON = "给这一集做一支 60 秒故事短片，用于投放测试";

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

function makeService(
  configOverrides: Partial<VideoStudioConfig> = {},
  storeOverrides: { signedUrl?: jest.Mock; put?: jest.Mock } = {},
) {
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
    adventureVideoAsset: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
    },
    adventureContentAuditLog: { create: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const config = {
    get: jest.fn(() => buildConfig(configOverrides)),
  } as unknown as ConfigService;
  const service = new AdventureVideoService(prisma as never, config, {
    put: storeOverrides.put ?? jest.fn(),
    signedUrl:
      storeOverrides.signedUrl ?? jest.fn(() => "https://oss/final.mp4?sig=1"),
  } as never);
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

  it("preview-url：没有成片返回 404，有成片返回签名地址", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue({ id: "job1" });
    prisma.adventureVideoAsset.findFirst.mockResolvedValue(null);
    await expect(service.previewUrl("job1")).rejects.toMatchObject({
      response: { code: "PREVIEW_NOT_READY" },
    });

    prisma.adventureVideoAsset.findFirst.mockResolvedValue({
      objectKey: "adventure-video/final.mp4",
    });
    await expect(service.previewUrl("job1")).resolves.toEqual({
      url: "https://oss/final.mp4?sig=1",
      expiresInSec: 3600,
    });
  });

  it("preview-url：OSS 未配置时给 503，不把底层异常裸奔出去", async () => {
    const prisma = {
      adventureVideoJob: {
        findUnique: jest.fn().mockResolvedValue({ id: "job1" }),
      },
      adventureVideoAsset: {
        findFirst: jest.fn().mockResolvedValue({ objectKey: "k" }),
      },
    };
    const service = new AdventureVideoService(
      prisma as never,
      { get: jest.fn(() => buildConfig()) } as never,
      {
        put: jest.fn(),
        signedUrl: jest.fn(() => {
          throw new Error("OSS 未配置");
        }),
      } as never,
    );
    await expect(service.previewUrl("job1")).rejects.toMatchObject({
      response: { code: "OSS_NOT_CONFIGURED" },
    });
  });
});

const REVIEW_TEXT = "星星".repeat(33);

function buildReviewStoryboard(): Storyboard {
  return {
    version: 1,
    title: "星星湖",
    businessKey: "elly/1/3",
    episodeVersionId: "v1",
    contentHash: "hash-v1",
    aspect: "9:16",
    resolution: "720P",
    stylePrompt: "柔和 3D 毛绒质感，暖色，儿童绘本动画",
    totalTextChars: REVIEW_TEXT.length * 4,
    beats: Array.from({ length: 4 }, (_, index) => ({
      order: index,
      sourceSegmentOrders: [Math.min(index, 1)],
      speaker: index === 2 ? ("elly" as const) : ("narrator" as const),
      text: REVIEW_TEXT,
      emotion:
        index === 0
          ? ("calm" as const)
          : index === 2
            ? ("gentle" as const)
            : ("curious" as const),
      characters: ["elly"] as Array<"elly" | "polly">,
      shot: "远景，镜头缓慢向前推",
      visualPrompt: "月光下的湖边，小象踩着浅水",
      optional: false,
    })),
    clips: [
      { order: 0, beats: [0, 1] },
      { order: 1, beats: [2, 3] },
    ],
  };
}

function buildReviewJob(storyboard: Storyboard = buildReviewStoryboard()) {
  return {
    id: "job1",
    episodeId: "ep1",
    episodeVersionId: "v1",
    businessKey: "elly/1/3",
    contentHash: "hash-v1",
    aspect: "9:16",
    resolution: "720P",
    status: "awaiting_review",
    stage: "review",
    voiceSetVersion: "system:abc",
    storyboard,
    storyboardRevision: 2,
    storyboardApprovedAt: null,
    storyboardApprovedBy: null,
    voiceTextHash: computeVoiceTextHash(storyboard.beats, "system:abc"),
    voiceTotalSec: 57.2,
    assets: [],
  };
}

function draftFrom(storyboard: Storyboard) {
  return {
    stylePrompt: storyboard.stylePrompt,
    beats: storyboard.beats.map((beat) => ({ ...beat })),
  };
}

function audioAssets(durationSec: number) {
  return Array.from({ length: 4 }, (_, order) => ({
    id: `asset-${order}`,
    jobId: "job1",
    kind: "audio",
    objectKey: `adventure-video/jobs/elly/1/3/hash-v1/job1/audio/beat-${order}.wav`,
    bytes: 10,
    durationSec,
    sha256: "sha",
    createdAt: new Date(2026, 0, 1, 0, 0, order),
  }));
}

describe("AdventureVideoService 分镜审核", () => {
  it("保存编辑稿：校验通过、revision+1、写审计", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    const draft = draftFrom(job.storyboard);
    draft.beats[0].text = "星光".repeat(33);
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    prisma.adventureVideoJob.update.mockResolvedValue({
      ...job,
      storyboardRevision: 3,
    });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});

    const result = await service.saveStoryboard(
      "job1",
      { storyboard: draft, expectedRevision: 2, reason: REASON },
      ACTOR,
    );

    expect(result.revision).toBe(3);
    expect(result.storyboard.beats[0].text).toBe("星光".repeat(33));
    expect(prisma.adventureVideoJob.update).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        storyboard: expect.any(Object),
        storyboardRevision: { increment: 1 },
        storyboardApprovedAt: null,
      }),
    });
    expect(prisma.adventureContentAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "video_storyboard_edit",
        actorUsername: "xiong",
      }),
    });
  });

  it("编辑稿不允许改结构：beat 数量/顺序/说话角色/角色集合锁定", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    const draft = draftFrom(job.storyboard);
    (draft.beats[0] as { speaker: string }).speaker = "polly";
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());

    await expect(
      service.saveStoryboard(
        "job1",
        { storyboard: draft, expectedRevision: 2, reason: REASON },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      response: { code: "STORYBOARD_STRUCTURE_LOCKED" },
    });
  });

  it("revision 落后时 409，不覆盖别人的编辑", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);

    await expect(
      service.saveStoryboard(
        "job1",
        {
          storyboard: draftFrom(job.storyboard),
          expectedRevision: 1,
          reason: REASON,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      response: { code: "STORYBOARD_CONFLICT", currentRevision: 2 },
    });
  });

  it("审批通过：实测 57 秒，写 approved 字段并入队", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(null);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    prisma.adventureVideoAsset.findMany.mockResolvedValue(audioAssets(14));
    prisma.adventureVideoJob.update.mockResolvedValue({
      ...job,
      status: "queued",
      stage: "queued",
      storyboardApprovedAt: new Date(),
      storyboardApprovedBy: "xiong",
    });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});

    const result = await service.approveStoryboard(
      "job1",
      { expectedRevision: 2, reason: REASON },
      ACTOR,
    );

    expect(result.plan.totalSec).toBeCloseTo(57.4, 2);
    expect(prisma.adventureVideoJob.update).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "queued",
        stage: "queued",
        storyboardApprovedBy: "xiong",
        storyboardApprovedAt: expect.any(Date),
      }),
    });
    expect(prisma.adventureContentAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "video_storyboard_approve" }),
    });
  });

  it("审批拒绝：实测不足 54 秒给出 actualSec", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    prisma.adventureVideoAsset.findMany.mockResolvedValue(audioAssets(10));

    await expect(
      service.approveStoryboard(
        "job1",
        { expectedRevision: 2, reason: REASON },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      response: {
        code: "VOICE_TOO_SHORT",
        actualSec: expect.any(Number),
      },
    });
    expect(prisma.adventureVideoJob.update).not.toHaveBeenCalled();
  });

  it("文案改过没重配：审批 409 VOICE_STALE", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    job.voiceTextHash = "stale";
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());

    await expect(
      service.approveStoryboard(
        "job1",
        { expectedRevision: 2, reason: REASON },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: "VOICE_STALE" } });
  });

  it("重新配音：清空音频与指纹，回到 queued", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureVideoJob.update.mockResolvedValue({
      ...job,
      status: "queued",
      stage: "queued",
      voiceTextHash: null,
      voiceTotalSec: null,
    });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});

    await service.revoiceStoryboard(
      "job1",
      { expectedRevision: 2, reason: REASON },
      ACTOR,
    );

    expect(prisma.adventureVideoAsset.deleteMany).toHaveBeenCalledWith({
      where: { jobId: "job1", kind: "audio" },
    });
    expect(prisma.adventureVideoJob.update).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "queued",
        voiceTextHash: null,
        voiceTotalSec: null,
      }),
    });
  });

  it("详情带 review：原文、实测时长、音频地址与 canApprove", async () => {
    const { service, prisma } = makeService();
    const job = {
      ...buildReviewJob(),
      assets: audioAssets(14),
    };
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());

    const detail = await service.get("job1");

    expect(detail.review.voice.ready).toBe(true);
    expect(detail.review.voice.totalSec).toBe(57.2);
    expect(detail.review.voice.textMatches).toBe(true);
    expect(detail.review.voice.beats).toHaveLength(4);
    expect(detail.review.voice.beats[0].audioUrl).toBe(
      "https://oss/final.mp4?sig=1",
    );
    expect(detail.review.sourceSegments).toHaveLength(2);
    expect(detail.review.canApprove).toBe(true);
  });

  it("待审核状态可以取消", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(buildReviewJob());
    prisma.adventureVideoJob.update.mockResolvedValue({
      ...buildReviewJob(),
      status: "canceled",
    });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});

    await expect(service.cancel("job1", ACTOR, REASON)).resolves.toBeTruthy();
  });
});

describe("AdventureVideoService 覆盖补齐", () => {
  it("capabilities 暴露审核写入能力", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoVoice.findMany.mockResolvedValue([]);
    const caps = await service.capabilities();
    expect(caps.reviewRequired).toBe(true);
    expect(caps.reviewWritable).toBe(true);
  });

  it("list 映射成片资产并按条件过滤", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findMany.mockResolvedValue([
      {
        id: "job1",
        assets: [{ objectKey: "final.mp4", bytes: 10, durationSec: 57 }],
      },
    ]);
    const result = await service.list({
      episodeId: "ep1",
      status: "awaiting_review",
    });
    expect(result.items[0].finalObjectKey).toBe("final.mp4");
    expect(result.items[0].finalDurationSec).toBe(57);
    expect(prisma.adventureVideoJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { episodeId: "ep1", status: "awaiting_review" },
      }),
    );
  });

  it("get 不存在返回 404", async () => {
    const { service, prisma } = makeService();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    await expect(service.get("job1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("validateDraft 成功返回预估，非待审核状态 409", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    const draft = await service.validateStoryboardDraft("job1", {
      storyboard: draftFrom(job.storyboard),
    });
    expect(draft.estimate.totalSec).toBeGreaterThan(54);

    prisma.adventureVideoJob.findUnique.mockResolvedValue({
      ...job,
      status: "running",
    });
    await expect(
      service.validateStoryboardDraft("job1", {
        storyboard: draftFrom(job.storyboard),
      }),
    ).rejects.toMatchObject({ response: { code: "JOB_NOT_REVIEWABLE" } });
  });

  it("regenerate 清空分镜、删音频并入队", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureVideoJob.update.mockResolvedValue({
      ...job,
      status: "queued",
      storyboard: null,
    });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});

    await service.regenerateStoryboard(
      "job1",
      { expectedRevision: 2, reason: REASON },
      ACTOR,
    );

    expect(prisma.adventureVideoAsset.deleteMany).toHaveBeenCalledWith({
      where: { jobId: "job1", kind: "audio" },
    });
    expect(prisma.adventureVideoJob.update).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        storyboard: expect.anything(),
        storyboardRevision: { increment: 1 },
        status: "queued",
        voiceTextHash: null,
      }),
    });
  });

  it("approve 超过 58 秒拒绝", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    prisma.adventureVideoAsset.findMany.mockResolvedValue(audioAssets(15));
    await expect(
      service.approveStoryboard(
        "job1",
        { expectedRevision: 2, reason: REASON },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: "VOICE_TOO_LONG" } });
  });

  it("approve 缺一段音频拒绝", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    prisma.adventureVideoAsset.findMany.mockResolvedValue(
      audioAssets(14).slice(0, 3),
    );
    await expect(
      service.approveStoryboard(
        "job1",
        { expectedRevision: 2, reason: REASON },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: "VOICE_ASSET_MISSING" } });
  });

  it("downloadUrl 带 attachment 文件名；无成片与 OSS 异常分别报错", async () => {
    const signedUrl = jest.fn(() => "https://oss/download");
    const { service, prisma } = makeService({}, { signedUrl });
    prisma.adventureVideoJob.findUnique.mockResolvedValue({
      id: "job1",
      businessKey: "elly/1/3",
    });
    prisma.adventureVideoAsset.findFirst.mockResolvedValue({
      objectKey: "final.mp4",
    });
    await expect(service.downloadUrl("job1")).resolves.toEqual({
      url: "https://oss/download",
      expiresInSec: 3600,
      filename: "elly-1-3-story.mp4",
    });
    expect(signedUrl).toHaveBeenCalledWith("final.mp4", undefined, {
      "content-disposition": 'attachment; filename="elly-1-3-story.mp4"',
    });

    prisma.adventureVideoAsset.findFirst.mockResolvedValue(null);
    await expect(service.downloadUrl("job1")).rejects.toMatchObject({
      response: { code: "PREVIEW_NOT_READY" },
    });
  });

  it("downloadUrl OSS 未配置时 503", async () => {
    const { service, prisma } = makeService(
      {},
      {
        signedUrl: jest.fn(() => {
          throw new Error("OSS 未配置");
        }),
      },
    );
    prisma.adventureVideoJob.findUnique.mockResolvedValue({
      id: "job1",
      businessKey: "elly/1/3",
    });
    prisma.adventureVideoAsset.findFirst.mockResolvedValue({
      objectKey: "final.mp4",
    });
    await expect(service.downloadUrl("job1")).rejects.toMatchObject({
      response: { code: "OSS_NOT_CONFIGURED" },
    });
  });

  it("retry 成功重新入队，不存在返回 404", async () => {
    const { service, prisma } = makeService();
    const job = {
      id: "job1",
      status: "failed",
      episodeId: "ep1",
      episodeVersionId: "v1",
      businessKey: "elly/1/3",
      attempts: 1,
    };
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureVideoJob.update.mockResolvedValue({
      ...job,
      status: "queued",
    });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});
    await expect(service.retry("job1", ACTOR, REASON)).resolves.toBeTruthy();
    expect(prisma.adventureVideoJob.update).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({ status: "queued", stage: "queued" }),
    });

    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    await expect(service.retry("job1", ACTOR, REASON)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("cancel 成功收尾，不存在返回 404", async () => {
    const { service, prisma } = makeService();
    const job = {
      id: "job1",
      status: "queued",
      episodeId: "ep1",
      episodeVersionId: "v1",
      businessKey: "elly/1/3",
    };
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureVideoJob.update.mockResolvedValue({
      ...job,
      status: "canceled",
    });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});
    await expect(service.cancel("job1", ACTOR, REASON)).resolves.toBeTruthy();

    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    await expect(service.cancel("job1", ACTOR, REASON)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("编辑稿结构锁定的三个分支：非对象/数量/顺序", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    const draft = draftFrom(job.storyboard);

    await expect(
      service.saveStoryboard(
        "job1",
        { storyboard: "x" as never, expectedRevision: 2 },
        ACTOR,
      ),
    ).rejects.toMatchObject({ response: { code: "STORYBOARD_TYPE" } });

    await expect(
      service.saveStoryboard(
        "job1",
        {
          storyboard: { ...draft, beats: draft.beats.slice(0, 3) },
          expectedRevision: 2,
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      response: { code: "STORYBOARD_STRUCTURE_LOCKED" },
    });

    const reordered = draftFrom(job.storyboard);
    reordered.beats[0].order = 1;
    await expect(
      service.saveStoryboard(
        "job1",
        { storyboard: reordered, expectedRevision: 2 },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      response: { code: "STORYBOARD_STRUCTURE_LOCKED" },
    });
  });

  it("validator 错误转成 400 并带 code/path", async () => {
    const { service, prisma } = makeService();
    const job = buildReviewJob();
    const draft = draftFrom(job.storyboard);
    draft.beats[0].text = "";
    prisma.adventureVideoJob.findUnique.mockResolvedValue(job);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    await expect(
      service.saveStoryboard(
        "job1",
        { storyboard: draft, expectedRevision: 2 },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      response: { code: "STORYBOARD_EMPTY", path: "beats[0].text" },
    });
  });

  it("get 在 OSS 签名失败时把 audioUrl 置空，不影响详情", async () => {
    const { service, prisma } = makeService(
      {},
      {
        signedUrl: jest.fn(() => {
          throw new Error("OSS 未配置");
        }),
      },
    );
    prisma.adventureVideoJob.findUnique.mockResolvedValue({
      ...buildReviewJob(),
      assets: audioAssets(14),
    });
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    const detail = await service.get("job1");
    expect(detail.review.voice.beats[0].audioUrl).toBeNull();
  });

  it("create 拒绝不支持的分辨率与画幅", async () => {
    const { service } = makeService();
    await expect(
      service.create("ep1", { ...DTO, resolution: "4K" as never }, ACTOR),
    ).rejects.toMatchObject({ response: { code: "UNSUPPORTED_RESOLUTION" } });
    await expect(
      service.create("ep1", { ...DTO, aspect: "16:9" as never }, ACTOR),
    ).rejects.toMatchObject({ response: { code: "UNSUPPORTED_ASPECT" } });
  });

  it("cloned 音色齐全时创建成功，voiceSetVersion 带 cloned 前缀", async () => {
    const { service, prisma } = makeService({ ttsMode: "cloned" });
    prisma.adventureVideoJob.findUnique.mockResolvedValue(null);
    prisma.adventureEpisode.findUnique.mockResolvedValue(buildEpisode());
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(buildVersion());
    prisma.adventureVideoVoice.findMany.mockResolvedValue([
      { role: "elly", status: "ready", voiceId: "c-elly" },
      { role: "polly", status: "ready", voiceId: "c-polly" },
      { role: "narrator", status: "ready", voiceId: "c-narrator" },
    ]);
    prisma.adventureVideoJob.create.mockResolvedValue({ id: "job1" });
    prisma.adventureContentAuditLog.create.mockResolvedValue({});

    await service.create("ep1", DTO, ACTOR);
    expect(
      prisma.adventureVideoJob.create.mock.calls[0][0].data.voiceSetVersion,
    ).toMatch(/^cloned:/);
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
