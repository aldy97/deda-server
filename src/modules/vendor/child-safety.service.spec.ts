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

  describe("L1 verdict source", () => {
    it("marks an explicit hit as l1_regex", () => {
      const verdict = service.checkL1("什么是做爱呀？");

      expect(verdict.source).toBe("l1_regex");
      expect(verdict.blocked).toBe(true);
    });

    it("marks a non-hit as l1_regex too (evaluated, nothing matched)", () => {
      // L1 未命中时该 verdict 不落库：编排会继续走 L2，最终 source 由 L2 决定
      const verdict = service.checkL1("今天幼儿园老师表扬我了");

      expect(verdict.source).toBe("l1_regex");
      expect(verdict.blocked).toBe(false);
      expect(verdict.category).toBeNull();
    });
  });

  describe("L2 small-model classifier", () => {
    it("returns safe when the model says safe", async () => {
      llmService.complete.mockResolvedValue({ text: "safe" });

      const verdict = await service.classifyL2("今天天气真好");

      expect(verdict).toEqual({
        blocked: false,
        category: "safe",
        layer: "L2",
        source: "l2_model",
      });
      expect(llmService.complete).toHaveBeenCalledWith(
        expect.objectContaining({ model: "small-llm", temperature: 0 }),
      );
    });

    it("threads turnId into the usage-logged LLM call when provided", async () => {
      llmService.complete.mockResolvedValue({ text: "safe" });

      await service.classifyL2("今天天气真好", "device-1", "turn-1");

      expect(llmService.complete).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "safety_l2", turnId: "turn-1" }),
      );
    });

    it("blocks paraphrased sexual content that dodged L1", async () => {
      llmService.complete.mockResolvedValue({ text: "sexual" });

      const verdict = await service.classifyL2("大人关门以后在干什么呀");

      expect(verdict.blocked).toBe(true);
      expect(verdict.category).toBe("sexual");
      expect(verdict.layer).toBe("L2");
      expect(verdict.source).toBe("l2_model");
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
      expect(verdict.source).toBe("l2_model");
    });

    it("tolerates a danger label wrapped in extra wording", async () => {
      llmService.complete.mockResolvedValue({ text: "标签：sexual。" });

      const verdict = await service.classifyL2("大人关门以后在干什么呀");

      expect(verdict.blocked).toBe(true);
      expect(verdict.category).toBe("sexual");
      expect(verdict.source).toBe("l2_model");
    });

    it("tolerates upper-case labels", async () => {
      llmService.complete.mockResolvedValue({ text: " SAFE " });

      const verdict = await service.classifyL2("今天天气真好");

      expect(verdict.category).toBe("safe");
      expect(verdict.source).toBe("l2_model");
    });

    it("flags garbage output as l2_invalid_label instead of silently passing as safe", async () => {
      llmService.complete.mockResolvedValue({ text: "我不知道" });

      const verdict = await service.classifyL2("你好");

      expect(verdict.blocked).toBe(false);
      expect(verdict.category).toBeNull();
      expect(verdict.layer).toBe("L2");
      expect(verdict.source).toBe("l2_invalid_label");
    });

    it("never reads a negation as safe: 'unsafe' is l2_invalid_label", async () => {
      // includes("safe") 会把 "unsafe" / "not safe" 误判成放行——方向恰好错反，
      // 故 safe 只接受精确匹配，否定式一律归为非法标签（放行但可观测）
      llmService.complete.mockResolvedValue({ text: "unsafe" });

      const verdict = await service.classifyL2("你好");

      expect(verdict.category).not.toBe("safe");
      expect(verdict.source).toBe("l2_invalid_label");
      expect(verdict.blocked).toBe(false);
    });

    it("never reads a negation as safe: 'not safe' is l2_invalid_label", async () => {
      llmService.complete.mockResolvedValue({ text: "not safe" });

      const verdict = await service.classifyL2("你好");

      expect(verdict.source).toBe("l2_invalid_label");
    });

    it("fails open when the small model errors, distinguishably from a real safe verdict", async () => {
      llmService.complete.mockRejectedValue(new Error("timeout"));

      const verdict = await service.classifyL2("你好");

      expect(verdict.blocked).toBe(false);
      expect(verdict.category).toBeNull();
      expect(verdict.layer).toBeNull();
      expect(verdict.source).toBe("l2_fail_open");
    });

    it("keeps safe / invalid_label / fail_open mutually distinguishable", async () => {
      // 三者曾经返回完全相同的 { blocked:false, category:null, layer:null }，
      // 导致「模型判定安全」与「小模型挂了裸奔」在看板上是同一个数字
      llmService.complete.mockResolvedValue({ text: "safe" });
      const safe = await service.classifyL2("你好");

      llmService.complete.mockResolvedValue({ text: "???" });
      const invalid = await service.classifyL2("你好");

      llmService.complete.mockRejectedValue(new Error("rate_limit"));
      const failed = await service.classifyL2("你好");

      const signatures = new Set(
        [safe, invalid, failed].map((v) => `${v.category}|${v.source}`),
      );
      expect(signatures.size).toBe(3);
      expect(safe.category).toBe("safe");
      expect(invalid.source).toBe("l2_invalid_label");
      expect(failed.source).toBe("l2_fail_open");
    });
  });

  describe("blocked 判定不因 source 引入而改变", () => {
    it.each([
      ["sexual", true],
      ["violence", true],
      ["self_harm", true],
      ["emotional_harm", false],
      ["safe", false],
    ])("category=%s → blocked=%s", async (label, blocked) => {
      llmService.complete.mockResolvedValue({ text: label });

      const verdict = await service.classifyL2("任意输入");

      expect(verdict.blocked).toBe(blocked);
      expect(verdict.category).toBe(label);
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
