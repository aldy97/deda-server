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

  it("instruction 超过 100 字符时截断，不把 400 留给上游", async () => {
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
    expect(http.post.mock.calls[0][1].input.instruction).toHaveLength(100);
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
