import { ConfigService } from "@nestjs/config";
import { BailianSpeechClient } from "./bailian-speech.client";
import { ProviderError } from "./provider.types";
import { resolveVideoStudioConfig } from "@/config/video.config";

function makeClient(overrides: { apiKey?: string; workspaceId?: string } = {}) {
  const base = resolveVideoStudioConfig(() => undefined);
  const config = {
    get: jest.fn(() => ({
      ...base,
      bailian: {
        apiKey: overrides.apiKey ?? "sk-test",
        workspaceId: overrides.workspaceId ?? "ws-test",
      },
    })),
  } as unknown as ConfigService;
  const http = { post: jest.fn(), get: jest.fn(), getBuffer: jest.fn() };
  return { client: new BailianSpeechClient(http as never, config), http };
}

describe("BailianSpeechClient", () => {
  it("合成：参数进 input，返回音频 URL 与计费字符数", async () => {
    const { client, http } = makeClient();
    http.post.mockResolvedValue({
      output: { audio: { url: "https://oss/a.wav" } },
      usage: { characters: 12 },
    });

    const result = await client.synthesize({
      model: "cosyvoice-v3-flash",
      voice: "longhua_v3",
      text: "小象沿着湖边慢慢走。",
      rate: 0.95,
      instruction: "温柔一点",
    });

    expect(result).toEqual({
      audioUrl: "https://oss/a.wav",
      characters: 12,
    });
    const [url, body, headers] = http.post.mock.calls[0];
    expect(url).toBe(
      "https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
    );
    expect(headers).toEqual({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
    expect(body).toEqual({
      model: "cosyvoice-v3-flash",
      input: {
        text: "小象沿着湖边慢慢走。",
        voice: "longhua_v3",
        format: "wav",
        sample_rate: 24000,
        rate: 0.95,
        instruction: "温柔一点",
      },
    });
  });

  it("instruction 按官方口径截断：汉字计 2，总量不超过 100", async () => {
    const { client, http } = makeClient();
    http.post.mockResolvedValue({
      output: { audio: { url: "https://oss/a.wav" } },
      usage: { characters: 3 },
    });
    await client.synthesize({
      model: "cosyvoice-v3-flash",
      voice: "longhua_v3",
      text: "你好",
      instruction: "温".repeat(150),
    });
    const instruction = http.post.mock.calls[0][1].input.instruction as string;
    expect(instruction).toHaveLength(50);
    expect(instruction).toBe("温".repeat(50));
  });

  it("instruction 混排时按权重截断，不切断代理对", async () => {
    const { client, http } = makeClient();
    http.post.mockResolvedValue({ output: { audio: { url: "u" } } });
    await client.synthesize({
      model: "cosyvoice-v3.5-flash",
      voice: "c1",
      text: "你好",
      instruction: `${"a".repeat(90)}${"温".repeat(10)}`,
    });
    // 90 个半角 + 5 个汉字 = 100 单位，第 6 个汉字放不进去
    expect(http.post.mock.calls[0][1].input.instruction).toBe(
      `${"a".repeat(90)}${"温".repeat(5)}`,
    );
  });

  it("非参数类上游错误保持原码原样抛出，不吞 retryable", async () => {
    const { client, http } = makeClient();
    const upstream = new ProviderError("bailian", "HTTP_500", "boom", true);
    http.post.mockRejectedValue(upstream);
    await expect(
      client.synthesize({ model: "m", voice: "v", text: "你好" }),
    ).rejects.toBe(upstream);
  });

  it("上游参数类错误（如 cosyvoice 428）换成领域码并带出音色与模型", async () => {
    const { client, http } = makeClient();
    http.post.mockRejectedValue(
      new ProviderError(
        "bailian",
        "InvalidParameter",
        "[cosyvoice:]Engine return error code: 428",
        false,
      ),
    );
    await expect(
      client.synthesize({
        model: "cosyvoice-v3-flash",
        voice: "longwan_v3",
        text: "小象走进山洞。",
        instruction: "语气平静",
      }),
    ).rejects.toMatchObject({
      code: "TTS_PARAMETER_INVALID",
      message: expect.stringContaining("longwan_v3"),
      retryable: false,
    });
  });

  it("缺字符用量时按文本长度计，避免成本统计变 NaN", async () => {
    const { client, http } = makeClient();
    http.post.mockResolvedValue({ output: { audio: { url: "u" } } });
    const result = await client.synthesize({
      model: "cosyvoice-v3-flash",
      voice: "v",
      text: "四个字符",
    });
    expect(result.characters).toBe(4);
  });

  it("空文本 / 无音频 URL / 缺配置都拒绝", async () => {
    const { client, http } = makeClient();
    await expect(
      client.synthesize({ model: "m", voice: "v", text: "   " }),
    ).rejects.toMatchObject({ code: "EMPTY_TEXT" });
    http.post.mockResolvedValue({ output: {} });
    await expect(
      client.synthesize({ model: "m", voice: "v", text: "hi" }),
    ).rejects.toBeInstanceOf(ProviderError);

    const missing = makeClient({ apiKey: "" });
    await expect(
      missing.client.synthesize({ model: "m", voice: "v", text: "hi" }),
    ).rejects.toMatchObject({ code: "API_KEY_MISSING" });
  });
});
