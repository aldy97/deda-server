import { ConfigService } from "@nestjs/config";
import { AdventureVideoWorkerService } from "./adventure-video-worker.service";
import {
  resolveVideoStudioConfig,
  type VideoStudioConfig,
} from "@/config/video.config";
import { PROMPT_DEFAULTS } from "@/modules/prompt-registry/prompt-defaults";
import { computeVoiceTextHash } from "../storyboard/storyboard.types";

const PAYLOAD = {
  title: "星星湖",
  segments: [
    { kind: "narration", text: "小象沿着湖边慢慢走。" },
    { kind: "narration", text: "忽然，湖面上亮起一颗星星。" },
    { kind: "interaction", text: "你愿意和我一起找星星吗？" },
  ],
};

const LONG_TEXT = "星星".repeat(33);

const STORYBOARD = {
  stylePrompt: "柔和 3D 毛绒质感，暖色，儿童绘本动画",
  beats: Array.from({ length: 4 }, (_, index) => ({
    order: index,
    sourceSegmentOrders: [Math.min(index, 2)],
    speaker: index === 2 ? ("elly" as const) : ("narrator" as const),
    text: LONG_TEXT,
    emotion:
      index === 0
        ? ("calm" as const)
        : index === 2
          ? ("gentle" as const)
          : ("curious" as const),
    characters: ["elly"],
    shot: "远景，镜头缓慢向前推",
    visualPrompt: "月光下的湖边，小象踩着浅水",
    optional: false,
  })),
  clips: [
    { order: 0, beats: [0, 1] },
    { order: 1, beats: [2, 3] },
  ],
};

function buildConfig() {
  return {
    ...resolveVideoStudioConfig(() => undefined),
    enabled: true,
    pollIntervalMs: 1,
    referenceKeys: { elly: "adventure-video/refs/elly.png" },
    lintForbiddenWords: ["坏人"],
  };
}

interface MakeWorkerOptions {
  approved?: boolean;
  audioDurationSec?: number;
  voiceTextHash?: string;
  ttsMode?: "system" | "cloned";
  ttsInstruction?: "on" | "off";
}

function makeWorker(options: MakeWorkerOptions = {}) {
  const approved = options.approved === true;
  const voiceSetVersion = "system:abc";
  const prisma = {
    adventureVideoJob: { findUnique: jest.fn(), update: jest.fn() },
    adventureEpisodeVersion: { findUnique: jest.fn() },
    adventureVideoVoice: { findMany: jest.fn().mockResolvedValue([]) },
    adventureVideoAsset: {
      create: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const queue = {
    claimNext: jest.fn(),
    markStage: jest.fn(),
    heartbeat: jest.fn(),
    awaitReview: jest.fn(),
    succeed: jest.fn(),
    fail: jest.fn(),
  };
  const video = { submit: jest.fn(), poll: jest.fn() };
  const speech = { synthesize: jest.fn() };
  const llm = { complete: jest.fn() };
  const promptRegistry = { render: jest.fn().mockReturnValue("DB-SYS-PROMPT") };
  const http = { post: jest.fn(), get: jest.fn(), getBuffer: jest.fn() };
  const store = {
    put: jest.fn(),
    get: jest.fn().mockResolvedValue(Buffer.from("audio-bytes")),
    signedUrl: jest.fn(),
  };
  const assembler = { probe: jest.fn(), assemble: jest.fn() };
  const config = {
    get: jest.fn(() => ({
      ...buildConfig(),
      ...(options.ttsMode ? { ttsMode: options.ttsMode } : {}),
      ...(options.ttsInstruction
        ? { ttsInstruction: options.ttsInstruction }
        : {}),
    })),
  } as unknown as ConfigService;

  const worker = new AdventureVideoWorkerService(
    prisma as never,
    queue as never,
    video as never,
    speech as never,
    llm as never,
    promptRegistry as never,
    http as never,
    store as never,
    assembler as never,
    config as never,
  );

  const audioDurationSec = options.audioDurationSec ?? 14;
  const audioAssets = Array.from({ length: 4 }, (_, order) => ({
    id: `asset-${order}`,
    jobId: "job1",
    kind: "audio",
    objectKey: `adventure-video/jobs/elly/1/3/hash-v1/job1/audio/beat-${order}.wav`,
    bytes: 10,
    durationSec: audioDurationSec,
    sha256: "sha",
    createdAt: new Date(2026, 0, 1, 0, 0, order),
  }));

  queue.claimNext.mockResolvedValue({ id: "job1", attempts: 0 });
  prisma.adventureVideoJob.findUnique.mockResolvedValue({
    id: "job1",
    episodeId: "ep1",
    episodeVersionId: "v1",
    businessKey: "elly/1/3",
    contentHash: "hash-v1",
    aspect: "9:16",
    resolution: "720P",
    renderer: "wan3.0-video",
    ttsMode: "system",
    voiceSetVersion,
    status: "running",
    storyboard: approved ? STORYBOARD : null,
    storyboardRevision: approved ? 1 : 0,
    storyboardApprovedAt: approved ? new Date() : null,
    storyboardApprovedBy: approved ? "alice" : null,
    voiceTextHash: approved
      ? (options.voiceTextHash ??
        computeVoiceTextHash(STORYBOARD.beats, voiceSetVersion))
      : null,
    voiceTotalSec: approved ? audioDurationSec * 4 : null,
  });
  if (approved) {
    prisma.adventureVideoAsset.findMany.mockResolvedValue(audioAssets);
  }
  prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
    id: "v1",
    payload: PAYLOAD,
  });
  llm.complete.mockResolvedValue({ text: JSON.stringify(STORYBOARD) });
  speech.synthesize.mockResolvedValue({
    audioUrl: "https://dashscope/audio.wav",
    characters: LONG_TEXT.length,
  });
  http.getBuffer.mockResolvedValue(Buffer.from("audio-bytes"));
  store.put.mockImplementation(async (objectKey: string, body: Buffer) => ({
    objectKey,
    bytes: body.length,
    sha256: "sha",
  }));
  store.signedUrl.mockReturnValue("https://oss/elly.png?sig=1");
  assembler.probe.mockResolvedValue({
    durationSec: audioDurationSec,
    width: 720,
    height: 1280,
    fps: 30,
    hasAudio: true,
  });
  video.submit.mockResolvedValueOnce("task-1").mockResolvedValueOnce("task-2");
  video.poll.mockResolvedValue({
    status: "succeeded",
    videoUrl: "https://bailian/video.mp4",
  });
  assembler.assemble.mockResolvedValue({
    buffer: Buffer.from("final"),
    durationSec: 57,
    srt: "1\n00:00:00,000 --> 00:00:01,000\n你好\n",
  });
  return {
    worker,
    prisma,
    queue,
    video,
    speech,
    llm,
    promptRegistry,
    http,
    store,
    assembler,
  };
}

describe("AdventureVideoWorkerService", () => {
  it("没有任务时返回 false", async () => {
    const { worker, queue } = makeWorker();
    queue.claimNext.mockResolvedValue(null);
    await expect(worker.runOnce()).resolves.toBe(false);
  });

  it("首次执行：分镜 + 4 段配音后暂停待审核，不调用视频", async () => {
    const {
      worker,
      prisma,
      queue,
      video,
      speech,
      llm,
      promptRegistry,
      assembler,
    } = makeWorker();

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ scene: "adventure_video_storyboard" }),
    );
    expect(llm.complete.mock.calls[0][0].messages[0]).toEqual({
      role: "system",
      content: "DB-SYS-PROMPT",
    });
    expect(promptRegistry.render).toHaveBeenCalledWith(
      "adventure_video_storyboard_system",
    );
    expect(prisma.adventureVideoJob.update).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: {
        storyboard: expect.any(Object),
        storyboardRevision: { increment: 1 },
      },
    });

    expect(speech.synthesize).toHaveBeenCalledTimes(4);
    expect(speech.synthesize.mock.calls[0][0]).toMatchObject({
      model: "cosyvoice-v3-flash",
      voice: "longwan_v3",
      format: "wav",
    });
    expect(assembler.probe).toHaveBeenCalledTimes(4);

    expect(queue.awaitReview).toHaveBeenCalledWith("job1", {
      voiceTextHash: computeVoiceTextHash(STORYBOARD.beats, "system:abc"),
      voiceTotalSec: 56,
    });
    expect(video.submit).not.toHaveBeenCalled();
    expect(assembler.assemble).not.toHaveBeenCalled();
    expect(queue.succeed).not.toHaveBeenCalled();
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("审批后执行：跳过分镜与配音，直接出 2 段视频并合成", async () => {
    const { worker, queue, video, speech, llm, store, assembler } = makeWorker({
      approved: true,
    });

    await expect(worker.runOnce()).resolves.toBe(true);

    expect(llm.complete).not.toHaveBeenCalled();
    expect(speech.synthesize).not.toHaveBeenCalled();
    expect(store.get).toHaveBeenCalledTimes(4);
    expect(video.submit).toHaveBeenCalledTimes(2);
    for (const [input] of video.submit.mock.calls) {
      expect(input.audio).toBe(false);
      expect(input.ratio).toBe("9:16");
      expect(input.durationSec).toBeGreaterThanOrEqual(2);
      expect(input.durationSec).toBeLessThanOrEqual(30);
      expect(input.referenceImageUrls).toEqual(["https://oss/elly.png?sig=1"]);
    }
    expect(assembler.assemble.mock.calls[0][0].cues).toHaveLength(4);
    expect(queue.succeed).toHaveBeenCalledWith("job1", {
      actualCostCents: expect.any(Number),
    });
    expect(queue.succeed.mock.calls[0][1].actualCostCents).toBeGreaterThan(0);
    expect(queue.fail).not.toHaveBeenCalled();
  });

  it("文案改过但音频没重配：审批后拒绝出片", async () => {
    const { worker, queue, video } = makeWorker({
      approved: true,
      voiceTextHash: "stale-hash",
    });

    await worker.runOnce();

    expect(queue.fail).toHaveBeenCalledWith(
      "job1",
      "VOICE_STALE",
      expect.stringContaining("重新配音"),
    );
    expect(video.submit).not.toHaveBeenCalled();
  });

  it("实测旁白不足 54 秒：拒绝出片并落领域码", async () => {
    const { worker, queue, video } = makeWorker({
      approved: true,
      audioDurationSec: 10,
    });

    await worker.runOnce();

    expect(queue.fail).toHaveBeenCalledWith(
      "job1",
      "VOICE_TOO_SHORT",
      expect.stringContaining("低于 54 秒"),
    );
    expect(video.submit).not.toHaveBeenCalled();
  });

  it("分镜文案含违禁词：重试一次后失败，不提交任何视频任务", async () => {
    const { worker, queue, video, llm } = makeWorker();
    const rewritten = JSON.parse(JSON.stringify(STORYBOARD));
    rewritten.beats[0].text = "小象打败了大坏人。";
    llm.complete.mockResolvedValue({ text: JSON.stringify(rewritten) });

    await worker.runOnce();

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(queue.fail).toHaveBeenCalledWith(
      "job1",
      "STORYBOARD_FORBIDDEN_WORD",
      expect.stringContaining("坏人"),
    );
    expect(video.submit).not.toHaveBeenCalled();
  });

  it("system 试跑音色不下发 instruction：v3-flash 三个音色不支持，发了会被 428 拒", async () => {
    const { worker, speech } = makeWorker();
    await worker.runOnce();
    expect(speech.synthesize).toHaveBeenCalledTimes(4);
    for (const [input] of speech.synthesize.mock.calls) {
      expect(input.model).toBe("cosyvoice-v3-flash");
      expect(input.instruction).toBeUndefined();
    }
  });

  it("cloned 模式（v3.5-flash）带情绪 instruction", async () => {
    const { worker, speech, prisma } = makeWorker({ ttsMode: "cloned" });
    prisma.adventureVideoVoice.findMany.mockResolvedValue([
      { role: "elly", status: "ready", voiceId: "c-elly" },
      { role: "polly", status: "ready", voiceId: "c-polly" },
      { role: "narrator", status: "ready", voiceId: "c-narrator" },
    ]);
    await worker.runOnce();
    expect(speech.synthesize.mock.calls[0][0]).toMatchObject({
      model: "cosyvoice-v3.5-flash",
      voice: "c-narrator",
      instruction: "语气平静，语速稍慢，像睡前故事",
    });
  });

  it("VIDEO_TTS_INSTRUCTION=off 时 cloned 也不下发 instruction", async () => {
    const { worker, speech, prisma } = makeWorker({
      ttsMode: "cloned",
      ttsInstruction: "off",
    });
    prisma.adventureVideoVoice.findMany.mockResolvedValue([
      { role: "elly", status: "ready", voiceId: "c-elly" },
      { role: "polly", status: "ready", voiceId: "c-polly" },
      { role: "narrator", status: "ready", voiceId: "c-narrator" },
    ]);
    await worker.runOnce();
    expect(speech.synthesize.mock.calls[0][0].instruction).toBeUndefined();
  });

  it("视频任务失败时落 failed，错误码透传", async () => {
    const { worker, queue, video } = makeWorker({ approved: true });
    video.poll.mockResolvedValue({
      status: "failed",
      errorCode: "UPSTREAM_500",
      errorMessage: "boom",
    });

    await worker.runOnce();

    expect(queue.fail).toHaveBeenCalledWith("job1", "UPSTREAM_500", "boom");
    expect(queue.succeed).not.toHaveBeenCalled();
  });
});

describe("分镜系统 prompt 的代码默认值契约", () => {
  it("完整故事导演硬规则在位（受控压缩 + 三幕闭环 + 54–58 秒）", () => {
    const template = PROMPT_DEFAULTS.adventure_video_storyboard_system.template;
    for (const keyword of [
      "忠于原文",
      "三幕闭环",
      "最多 8 个 beat",
      "54–58 秒",
      "230–265",
      "只输出一个 JSON",
    ]) {
      expect(template).toContain(keyword);
    }
  });
});
