import { ConfigService } from "@nestjs/config";
import { AdventureVideoWorkerService } from "./adventure-video-worker.service";
import { resolveVideoStudioConfig } from "@/config/video.config";
import { PROMPT_DEFAULTS } from "@/modules/prompt-registry/prompt-defaults";

const PAYLOAD = {
  title: "星星湖",
  segments: [
    { kind: "narration", text: "小象沿着湖边慢慢走。" },
    { kind: "narration", text: "忽然，湖面上亮起一颗星星。" },
    { kind: "interaction", text: "你愿意和我一起找星星吗？" },
  ],
};

const STORYBOARD = {
  stylePrompt: "柔和 3D 毛绒质感，暖色，儿童绘本动画",
  beats: [
    {
      order: 0,
      sourceSegmentOrders: [0],
      speaker: "narrator",
      text: "小象沿着湖边慢慢走。",
      emotion: "calm",
      characters: ["elly"],
      shot: "远景，镜头缓慢向前推",
      visualPrompt: "月光下的湖边，小象踩着浅水",
      optional: false,
    },
    {
      order: 1,
      sourceSegmentOrders: [1],
      speaker: "narrator",
      text: "忽然，湖面上亮起一颗星星。",
      emotion: "curious",
      characters: ["elly"],
      shot: "特写，小象抬头",
      visualPrompt: "湖面亮起一颗星星",
      optional: false,
    },
    {
      order: 2,
      sourceSegmentOrders: [2],
      speaker: "elly",
      text: "你愿意和我一起找星星吗？",
      emotion: "gentle",
      characters: ["elly"],
      shot: "近景，小象看向镜头",
      visualPrompt: "小象伸出鼻子，像在邀请",
      optional: false,
    },
  ],
  clips: [
    { order: 0, beats: [0, 1] },
    { order: 1, beats: [2] },
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

function makeWorker() {
  const prisma = {
    adventureVideoJob: { findUnique: jest.fn(), update: jest.fn() },
    adventureEpisodeVersion: { findUnique: jest.fn() },
    adventureVideoVoice: { findMany: jest.fn().mockResolvedValue([]) },
    adventureVideoAsset: { create: jest.fn(), createMany: jest.fn() },
  };
  const queue = {
    claimNext: jest.fn(),
    markStage: jest.fn(),
    heartbeat: jest.fn(),
    succeed: jest.fn(),
    fail: jest.fn(),
  };
  const video = { submit: jest.fn(), poll: jest.fn() };
  const speech = { synthesize: jest.fn() };
  const llm = { complete: jest.fn() };
  const promptRegistry = { render: jest.fn().mockReturnValue("DB-SYS-PROMPT") };
  const http = { post: jest.fn(), get: jest.fn(), getBuffer: jest.fn() };
  const store = { put: jest.fn(), signedUrl: jest.fn() };
  const assembler = { probe: jest.fn(), assemble: jest.fn() };
  const config = {
    get: jest.fn(() => buildConfig()),
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
    status: "running",
  });
  prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
    id: "v1",
    payload: PAYLOAD,
  });
  llm.complete.mockResolvedValue({ text: JSON.stringify(STORYBOARD) });
  speech.synthesize.mockResolvedValue({
    audioUrl: "https://dashscope/audio.wav",
    characters: 12,
  });
  http.getBuffer.mockResolvedValue(Buffer.from("audio-bytes"));
  store.put.mockImplementation(async (objectKey: string, body: Buffer) => ({
    objectKey,
    bytes: body.length,
    sha256: "sha",
  }));
  store.signedUrl.mockReturnValue("https://oss/elly.png?sig=1");
  assembler.probe.mockResolvedValue({
    durationSec: 12,
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
    durationSec: 40,
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

  it("跑通一条：分镜 → 3 段配音 → 2 段视频 → 合成 → 成功", async () => {
    const {
      worker,
      prisma,
      queue,
      video,
      speech,
      llm,
      promptRegistry,
      store,
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
      data: { storyboard: expect.any(Object) },
    });

    expect(speech.synthesize).toHaveBeenCalledTimes(3);
    expect(speech.synthesize.mock.calls[0][0]).toMatchObject({
      model: "cosyvoice-v3-flash",
      voice: "longwan_v3",
      format: "wav",
    });

    expect(video.submit).toHaveBeenCalledTimes(2);
    for (const [input] of video.submit.mock.calls) {
      expect(input.audio).toBe(false);
      expect(input.ratio).toBe("9:16");
      expect(input.durationSec).toBeGreaterThanOrEqual(2);
      expect(input.durationSec).toBeLessThanOrEqual(30);
      expect(input.referenceImageUrls).toEqual(["https://oss/elly.png?sig=1"]);
    }

    expect(store.put).toHaveBeenCalled();
    expect(assembler.assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        aspect: "9:16",
        resolution: "720P",
      }),
    );
    expect(assembler.assemble.mock.calls[0][0].cues).toHaveLength(3);
    expect(queue.succeed).toHaveBeenCalledWith("job1", {
      actualCostCents: expect.any(Number),
    });
    expect(queue.succeed.mock.calls[0][1].actualCostCents).toBeGreaterThan(0);
    expect(queue.fail).not.toHaveBeenCalled();
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

  it("视频任务失败时落 failed，错误码透传", async () => {
    const { worker, queue, video } = makeWorker();
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
  it("完整故事导演硬规则在位（受控压缩 + 三幕闭环）", () => {
    const template = PROMPT_DEFAULTS.adventure_video_storyboard_system.template;
    for (const keyword of [
      "忠于原文",
      "三幕闭环",
      "最多 8 个 beat",
      "180",
      "只输出一个 JSON",
    ]) {
      expect(template).toContain(keyword);
    }
  });
});
