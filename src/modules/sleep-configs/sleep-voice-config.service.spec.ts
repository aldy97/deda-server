import { Test, TestingModule } from "@nestjs/testing";
import { SleepVoiceConfigService } from "./sleep-voice-config.service";
import { SleepConfigsService } from "./sleep-configs.service";
import { LlmService } from "@/modules/llm/llm.service";

describe("SleepVoiceConfigService", () => {
  let service: SleepVoiceConfigService;
  let sleepConfigs: { applyVoiceUpdate: jest.Mock };
  let llm: { complete: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SleepVoiceConfigService,
        {
          provide: SleepConfigsService,
          useValue: {
            applyVoiceUpdate: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: LlmService,
          useValue: {
            complete: jest.fn(),
            get smallModelName() {
              return "small-llm";
            },
          },
        },
      ],
    }).compile();

    service = module.get<SleepVoiceConfigService>(SleepVoiceConfigService);
    sleepConfigs = module.get(SleepConfigsService) as any;
    llm = module.get(LlmService) as any;
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("applies contentType=song and confirms in child-friendly words", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"contentType","value":"song"}',
    });

    const result = await service.handle("device-1", "以后睡前都听儿歌");

    expect(sleepConfigs.applyVoiceUpdate).toHaveBeenCalledWith("device-1", {
      contentType: "song",
    });
    expect(result.applied).toBe(true);
    expect(result.field).toBe("contentType");
    expect(result.replyText).toContain("儿歌");
  });

  it("applies contentType=story", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"contentType","value":"story"}',
    });

    const result = await service.handle("device-1", "以后睡前听故事");

    expect(sleepConfigs.applyVoiceUpdate).toHaveBeenCalledWith("device-1", {
      contentType: "story",
    });
    expect(result.replyText).toContain("故事");
  });

  it("applies contentType=mixed", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"contentType","value":"mixed"}',
    });

    const result = await service.handle("device-1", "睡前故事和儿歌都要");

    expect(sleepConfigs.applyVoiceUpdate).toHaveBeenCalledWith("device-1", {
      contentType: "mixed",
    });
    expect(result.replyText).toContain("故事");
    expect(result.replyText).toContain("儿歌");
  });

  it("applies durationMinutes and implies custom mode", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"durationMinutes","value":20}',
    });

    const result = await service.handle("device-1", "哄睡改成20分钟");

    expect(sleepConfigs.applyVoiceUpdate).toHaveBeenCalledWith("device-1", {
      durationMode: "custom",
      durationMinutes: 20,
    });
    expect(result.replyText).toContain("20");
  });

  it("applies sleepTime", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"sleepTime","value":"21:30"}',
    });

    const result = await service.handle("device-1", "明天九点半哄我睡觉");

    expect(sleepConfigs.applyVoiceUpdate).toHaveBeenCalledWith("device-1", {
      sleepTime: "21:30",
    });
    expect(result.replyText).toContain("21:30");
  });

  it("rejects durationMinutes outside the allowed set", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"durationMinutes","value":12}',
    });

    const result = await service.handle("device-1", "哄睡改成12分钟");

    expect(sleepConfigs.applyVoiceUpdate).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.replyText).toContain("10");
  });

  it("rejects invalid sleepTime format", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"sleepTime","value":"25:00"}',
    });

    const result = await service.handle("device-1", "二十五点哄我睡觉");

    expect(sleepConfigs.applyVoiceUpdate).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("rejects unknown contentType value", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"contentType","value":"video"}',
    });

    const result = await service.handle("device-1", "睡前看视频");

    expect(sleepConfigs.applyVoiceUpdate).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("falls back when the model cannot extract a field", async () => {
    llm.complete.mockResolvedValue({ text: '{"field":null}' });

    const result = await service.handle("device-1", "哄睡嘛随便啦");

    expect(sleepConfigs.applyVoiceUpdate).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.replyText.length).toBeGreaterThan(0);
  });

  it("falls back on malformed model output", async () => {
    llm.complete.mockResolvedValue({ text: "not json at all" });

    const result = await service.handle("device-1", "哄睡改成20分钟");

    expect(sleepConfigs.applyVoiceUpdate).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("falls back when the model call fails", async () => {
    llm.complete.mockRejectedValue(new Error("llm down"));

    const result = await service.handle("device-1", "哄睡改成20分钟");

    expect(sleepConfigs.applyVoiceUpdate).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("falls back when persistence fails", async () => {
    llm.complete.mockResolvedValue({
      text: '{"field":"contentType","value":"song"}',
    });
    sleepConfigs.applyVoiceUpdate.mockRejectedValue(new Error("db down"));

    const result = await service.handle("device-1", "以后睡前都听儿歌");

    expect(result.applied).toBe(false);
  });
});
