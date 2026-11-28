import {
  buildCreateVoiceBody,
  parseCreatedVoiceId,
  parseVoiceStatus,
  toAudioDataUri,
} from "./voice-enrollment";

describe("voice-enrollment", () => {
  it("构造 create_voice 请求：默认 zh、prefix 校验", () => {
    const body = buildCreateVoiceBody({
      targetModel: "cosyvoice-v3.5-flash",
      prefix: "Elly01",
      audioDataUri: "data:audio/wav;base64,AAAA",
    });
    expect(body).toEqual({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: "cosyvoice-v3.5-flash",
        audio: "data:audio/wav;base64,AAAA",
        prefix: "Elly01",
        language_hints: ["zh"],
      },
    });
    expect(() =>
      buildCreateVoiceBody({
        targetModel: "m",
        prefix: "含中文",
        audioDataUri: "data:audio/wav;base64,AA",
      }),
    ).toThrow(/prefix/);
  });

  it("没有 voice_id / status 时明确报错或回落", () => {
    expect(parseCreatedVoiceId({ output: { voice_id: "v1" } })).toBe("v1");
    expect(() => parseCreatedVoiceId({ output: {} })).toThrow(/voice_id/);
    expect(parseVoiceStatus({ output: { status: "OK" } })).toBe("OK");
    expect(parseVoiceStatus({})).toBe("UNKNOWN");
  });

  it("音频 MIME 由扩展名决定，未知格式拒绝", () => {
    expect(toAudioDataUri(Buffer.from("a"), "elly.wav")).toMatch(
      /^data:audio\/wav;base64,/,
    );
    expect(toAudioDataUri(Buffer.from("a"), "elly.mp3")).toMatch(
      /^data:audio\/mpeg;base64,/,
    );
    expect(() => toAudioDataUri(Buffer.from("a"), "elly.flac")).toThrow(
      /不支持/,
    );
  });
});
