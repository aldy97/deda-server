import {
  buildAssSubtitles,
  buildAudioMixArgs,
  buildConcatArgs,
  buildFinalArgs,
  buildNormalizeArgs,
  buildSrt,
  escapeFilterPath,
  parseProbeOutput,
  resolutionToSize,
} from "./ffmpeg.args";

describe("ffmpeg.args", () => {
  it("归一化：缩放、补边、setsar、帧率，且不带音轨", () => {
    const args = buildNormalizeArgs({
      input: "in.mp4",
      output: "out.mp4",
      width: 720,
      height: 1280,
    });
    expect(args).toContain("-an");
    const filter = args[args.indexOf("-vf") + 1];
    expect(filter).toContain("scale=720:1280");
    expect(filter).toContain("pad=720:1280");
    expect(filter).toContain("setsar=1");
    expect(filter).toContain("fps=30");
  });

  it("concat 用安全模式 0，避免绝对路径被拒", () => {
    expect(buildConcatArgs("/tmp/list.txt", "out.mp4")).toEqual([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "/tmp/list.txt",
      "-c",
      "copy",
      "out.mp4",
    ]);
  });

  it("旁白铺轨：底噪 + 每段 adelay + amix + atrim", () => {
    const args = buildAudioMixArgs(
      [
        { path: "a.wav", delayMs: 400 },
        { path: "b.wav", delayMs: 5_200 },
      ],
      12,
      "mix.wav",
    );
    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("adelay=400:all=1");
    expect(filter).toContain("adelay=5200:all=1");
    expect(filter).toContain("amix=inputs=3:normalize=0");
    expect(filter).toContain("atrim=0:12.000");
    expect(args).toContain("anullsrc=r=24000:cl=mono");
  });

  it("最终合成：烧字幕、loudnorm、faststart、shortest", () => {
    const args = buildFinalArgs({
      video: "v.mp4",
      audio: "a.wav",
      assFile: "/tmp/sub.ass",
      output: "final.mp4",
    });
    expect(args[args.indexOf("-vf") + 1]).toBe("subtitles=/tmp/sub.ass");
    expect(args[args.indexOf("-af") + 1]).toContain("loudnorm");
    expect(args).toContain("+faststart");
    expect(args).toContain("-shortest");
  });

  it("滤镜路径里的冒号与单引号要转义，否则 ffmpeg 解析直接失败", () => {
    expect(escapeFilterPath("/tmp/a:b'c.ass")).toBe("/tmp/a\\:b\\'c.ass");
    const args = buildFinalArgs({
      video: "v",
      audio: "a",
      assFile: "/tmp/a:b.ass",
      output: "o",
    });
    expect(args[args.indexOf("-vf") + 1]).toContain("a\\:b.ass");
  });

  it("ASS：时间戳、安全区边距、花括号替换", () => {
    const ass = buildAssSubtitles(
      [
        { startSec: 0.5, endSec: 3.25, text: "第一句" },
        { startSec: 61.04, endSec: 63, text: "带{标签}的句子\n第二行" },
      ],
      { width: 720, height: 1280 },
    );
    expect(ass).toContain("PlayResX: 720");
    expect(ass).toContain("Dialogue: 0,0:00:00.50,0:00:03.25");
    expect(ass).toContain("Dialogue: 0,0:01:01.04,0:01:03.00");
    expect(ass).toContain("带（标签）的句子 第二行");
    expect(ass).not.toContain("{标签}");
  });

  it("SRT：标准序号与毫秒时间戳", () => {
    const srt = buildSrt([{ startSec: 1.5, endSec: 2.25, text: "你好" }]);
    expect(srt).toBe("1\n00:00:01,500 --> 00:00:02,250\n你好\n");
  });

  it("probe JSON 解析：时长、分辨率、帧率、音轨", () => {
    expect(
      parseProbeOutput({
        format: { duration: "30.200000" },
        streams: [
          {
            codec_type: "video",
            width: 720,
            height: 1280,
            r_frame_rate: "30/1",
          },
          { codec_type: "audio" },
        ],
      }),
    ).toEqual({
      durationSec: 30.2,
      width: 720,
      height: 1280,
      fps: 30,
      hasAudio: true,
    });
  });

  it("probe 缺字段时返回 0，不抛错", () => {
    expect(parseProbeOutput({})).toEqual({
      durationSec: 0,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: false,
    });
  });

  it("分辨率映射", () => {
    expect(resolutionToSize("720P")).toEqual({ width: 720, height: 1280 });
    expect(resolutionToSize("1080P")).toEqual({ width: 1080, height: 1920 });
    expect(resolutionToSize("unknown")).toEqual({ width: 720, height: 1280 });
  });
});
