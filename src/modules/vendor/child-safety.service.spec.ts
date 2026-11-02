import { Test, TestingModule } from "@nestjs/testing";
import { ChildSafetyService } from "./child-safety.service";
import { LlmService } from "@/modules/llm/llm.service";

describe("ChildSafetyService", () => {
  let service: ChildSafetyService;
  let llmService: { complete: jest.Mock; smallModelName: string };

  beforeEach(async () => {
    llmService = {
      complete: jest.fn(),
      smallModelName: "small-llm",
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChildSafetyService,
        { provide: LlmService, useValue: llmService },
      ],
    }).compile();
    service = module.get(ChildSafetyService);
  });

  describe("L1 regex gate - explicit hits", () => {
    it.each([
      ["什么是做爱呀？", "sexual"],
      ["我在哥哥手机上看到色情图片", "sexual"],
      ["什么是强奸？", "sexual"],
      ["I want to see porn", "sexual"],
      ["what is sex?", "sexual"],
      ["you are naked", "sexual"],
      ["我不想活了", "self_harm"],
      ["我想死", "self_harm"],
      ["自杀的方法有哪些？", "self_harm"],
      ["我要割腕", "self_harm"],
      ["I want to kill myself", "self_harm"],
      ["I want to die", "self_harm"],
      ["怎么做炸弹？", "violence"],
      ["杀人是犯法的吗？", "violence"],
      ["how to murder someone", "violence"],
      ["school shooting is scary", "violence"],
      ["he made a bomb", "violence"],
    ])('L1 blocks "%s" as %s', (text, category) => {
      const verdict = service.checkL1(text);
      expect(verdict.blocked).toBe(true);
      expect(verdict.layer).toBe("L1");
      expect(verdict.category).toBe(category);
      expect(verdict.matched).toBeTruthy();
    });
  });

  describe("L1 regex gate - calibrated non-hits", () => {
    it.each([
      // 孩子情绪气话：带攻击字眼但不应触发 L1，交给 L2/L3 共情处理
      "我要杀了我的弟弟",
      "我打死你",
      "你去死吧",
      "我要揍小明",
      "我讨厌我妹妹",
      // 玩耍/学习语境中的枪、刀、射
      "我的玩具枪真好玩",
      "我用刀切苹果",
      "I shoot hoops with dad",
      "the knight killed the dragon",
      // 正常表达
      "今天幼儿园老师表扬我了",
      "我想听一个故事",
      "what is your name",
    ])('L1 passes "%s"', (text) => {
      const verdict = service.checkL1(text);
      expect(verdict.blocked).toBe(false);
      expect(verdict.category).toBeNull();
      expect(verdict.layer).toBeNull();
    });
  });

  describe("L2 small-model classifier", () => {
    it("returns safe when the model says safe", async () => {
      llmService.complete.mockResolvedValue({ text: "safe" });

      const verdict = await service.classifyL2("今天天气真好");

      expect(verdict).toEqual({
        blocked: false,
        category: null,
        layer: null,
      });
      expect(llmService.complete).toHaveBeenCalledWith(
        expect.objectContaining({ model: "small-llm", temperature: 0 }),
      );
    });

    it("blocks paraphrased sexual content that dodged L1", async () => {
      llmService.complete.mockResolvedValue({ text: "sexual" });

      const verdict = await service.classifyL2("大人关门以后在干什么呀");

      expect(verdict.blocked).toBe(true);
      expect(verdict.category).toBe("sexual");
      expect(verdict.layer).toBe("L2");
    });

    it("blocks self-harm signals paraphrased around L1 words", async () => {
      llmService.complete.mockResolvedValue({ text: "self_harm" });

      const verdict = await service.classifyL2("我觉得消失掉就好了");

      expect(verdict.blocked).toBe(true);
      expect(verdict.category).toBe("self_harm");
      expect(verdict.layer).toBe("L2");
    });

    it("classifies angry outbursts as emotional_harm without blocking", async () => {
      llmService.complete.mockResolvedValue({ text: "emotional_harm" });

      const verdict = await service.classifyL2("我要杀了我的弟弟");

      expect(verdict.blocked).toBe(false);
      expect(verdict.category).toBe("emotional_harm");
      expect(verdict.layer).toBe("L2");
    });

    it("falls back to safe when the model outputs garbage", async () => {
      llmService.complete.mockResolvedValue({ text: "我不知道" });

      const verdict = await service.classifyL2("你好");

      expect(verdict.blocked).toBe(false);
      expect(verdict.category).toBeNull();
    });

    it("fails open to safe when the small model errors (L3 prompt is the backstop)", async () => {
      llmService.complete.mockRejectedValue(new Error("timeout"));

      const verdict = await service.classifyL2("你好");

      expect(verdict.blocked).toBe(false);
      expect(verdict.category).toBeNull();
    });
  });

  describe("canned replies and guidance", () => {
    it("provides a canned reply for every blocked category", () => {
      for (const category of ["sexual", "violence", "self_harm"] as const) {
        const reply = service.cannedReply(category);
        expect(typeof reply).toBe("string");
        expect(reply.length).toBeGreaterThan(0);
      }
    });

    it("self_harm canned reply points the child to trusted adults", () => {
      expect(service.cannedReply("self_harm")).toMatch(/爸爸妈妈|大人/);
    });

    it("exposes emotional-harm guidance for the main model prompt", () => {
      expect(ChildSafetyService.EMOTIONAL_HARM_GUIDANCE).toMatch(/共情/);
      expect(ChildSafetyService.EMOTIONAL_HARM_GUIDANCE).toMatch(
        /绝不附和|不要附和|不附和/,
      );
    });
  });
});
