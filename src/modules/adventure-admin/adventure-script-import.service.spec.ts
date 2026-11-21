import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import * as mammoth from "mammoth";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import {
  MAX_DOCX_BYTES,
  AdventureScriptImportService,
  normalizeScriptOutput,
  parseLlmJson,
  splitTitle,
} from "./adventure-script-import.service";

jest.mock("mammoth", () => ({
  extractRawText: jest.fn(),
}));

const EMPTY_LINT = { ok: true, issues: [], errors: [], warnings: [] };

describe("splitTitle", () => {
  it("takes the first non-empty line as title and the rest as body", () => {
    const { title, body } = splitTitle("森林冒险\n\n第一段旁白\n第二段旁白");
    expect(title).toBe("森林冒险");
    expect(body).toBe("第一段旁白\n第二段旁白");
  });

  it("skips leading blank lines", () => {
    const { title, body } = splitTitle("\n\n  标题  \n正文");
    expect(title).toBe("标题");
    expect(body).toBe("正文");
  });

  it("returns empty title when the text is blank", () => {
    expect(splitTitle("   \n  ")).toEqual({ title: "", body: "   \n  " });
  });

  it("returns empty body for a single-line script", () => {
    expect(splitTitle("只有标题")).toEqual({ title: "只有标题", body: "" });
  });
});

describe("parseLlmJson", () => {
  it("parses plain JSON", () => {
    expect(parseLlmJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips a markdown fence", () => {
    expect(parseLlmJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("throws SCRIPT_CONVERT_FAILED on invalid JSON", () => {
    let caught: BadRequestException | null = null;
    try {
      parseLlmJson("not json");
    } catch (error) {
      caught = error as BadRequestException;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught?.getResponse()).toMatchObject({
      code: "SCRIPT_CONVERT_FAILED",
    });
  });
});

describe("normalizeScriptOutput", () => {
  it("reindexes segments 0..n-1 and keeps narration verbatim", () => {
    const out = normalizeScriptOutput({
      characterKey: "elly",
      recap: "",
      segments: [
        { kind: "narration", text: "旁白一" },
        { kind: "narration", text: "旁白二" },
      ],
    });
    expect(out.characterKey).toBe("elly");
    expect(out.characterDetected).toBe(true);
    expect(out.recap).toBeNull();
    expect(out.segments).toEqual([
      {
        order: 0,
        kind: "narration",
        text: "旁白一",
        interactionType: null,
        options: null,
        fallbackText: null,
        rewardStar: false,
      },
      {
        order: 1,
        kind: "narration",
        text: "旁白二",
        interactionType: null,
        options: null,
        fallbackText: null,
        rewardStar: false,
      },
    ]);
  });

  it("falls back to elly when the characterKey is not whitelisted", () => {
    const out = normalizeScriptOutput({
      characterKey: "pikachu",
      segments: [],
    });
    expect(out.characterKey).toBe("elly");
    expect(out.characterDetected).toBe(false);
  });

  it("falls back to an empty script when the input is not an object", () => {
    const out = normalizeScriptOutput(null);
    expect(out.characterKey).toBe("elly");
    expect(out.characterDetected).toBe(false);
    expect(out.recap).toBeNull();
    expect(out.segments).toEqual([]);
  });

  it("truncates two_choice options to exactly two", () => {
    const out = normalizeScriptOutput({
      characterKey: "polly",
      segments: [
        {
          kind: "interaction",
          interactionType: "two_choice",
          text: "选哪个",
          fallbackText: "想一想",
          options: {
            choices: [
              { key: "A", text: "苹果", reply: "好甜" },
              { key: "B", text: "香蕉", reply: "好软" },
              { key: "C", text: "橘子", reply: "好酸" },
            ],
          },
        },
      ],
    });
    const segment = out.segments[0];
    expect(segment.options?.choices).toHaveLength(2);
    expect(segment.options?.choices?.[1]).toEqual({
      key: "B",
      text: "香蕉",
      reply: "好软",
    });
    expect(segment.fallbackText).toBe("想一想");
    expect(segment.rewardStar).toBe(false);
  });

  it("downgrades an unknown interactionType to null instead of dropping the segment", () => {
    const out = normalizeScriptOutput({
      characterKey: "elly",
      segments: [
        { kind: "interaction", interactionType: "dance_party", text: "跳一跳" },
      ],
    });
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].interactionType).toBeNull();
  });

  it("drops non-object segments", () => {
    const out = normalizeScriptOutput({
      characterKey: "elly",
      segments: [null, "junk", { kind: "narration", text: "正文" }],
    });
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe("正文");
  });

  it("keeps repeat_after_me praise and reward star", () => {
    const out = normalizeScriptOutput({
      characterKey: "elly",
      segments: [
        {
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "念一句",
          options: { praise: "真棒" },
          fallbackText: "再来一次",
        },
        {
          kind: "interaction",
          interactionType: "reward",
          text: "好样的",
          rewardStar: true,
        },
      ],
    });
    expect(out.segments[0].options).toEqual({ praise: "真棒" });
    expect(out.segments[1].rewardStar).toBe(true);
    expect(out.segments[1].options).toBeNull();
  });

  it("normalizes recap whitespace to null when empty", () => {
    expect(
      normalizeScriptOutput({
        characterKey: "elly",
        recap: "   ",
        segments: [],
      }).recap,
    ).toBeNull();
    expect(
      normalizeScriptOutput({
        characterKey: "elly",
        recap: "上集回顾",
        segments: [],
      }).recap,
    ).toBe("上集回顾");
  });

  it("falls back to an empty choices array for two_choice with malformed options", () => {
    const nullOptions = normalizeScriptOutput({
      characterKey: "elly",
      segments: [
        {
          kind: "interaction",
          interactionType: "two_choice",
          text: "选",
          options: null,
        },
      ],
    });
    expect(nullOptions.segments[0].options).toEqual({ choices: [] });

    const nonArray = normalizeScriptOutput({
      characterKey: "elly",
      segments: [
        {
          kind: "interaction",
          interactionType: "two_choice",
          text: "选",
          options: { choices: "不是数组" },
        },
      ],
    });
    expect(nonArray.segments[0].options).toEqual({ choices: [] });
  });

  it("normalizes a non-object choice item to an empty choice", () => {
    const out = normalizeScriptOutput({
      characterKey: "elly",
      segments: [
        {
          kind: "interaction",
          interactionType: "two_choice",
          text: "选",
          options: {
            choices: ["junk", { key: "A", text: "苹果", reply: "甜" }],
          },
        },
      ],
    });
    expect(out.segments[0].options?.choices).toEqual([
      { key: "", text: "", reply: "" },
      { key: "A", text: "苹果", reply: "甜" },
    ]);
  });

  it("falls back to null praise for repeat_after_me with missing or empty praise", () => {
    const missing = normalizeScriptOutput({
      characterKey: "elly",
      segments: [
        {
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "念",
          options: null,
        },
      ],
    });
    expect(missing.segments[0].options).toBeNull();

    const empty = normalizeScriptOutput({
      characterKey: "elly",
      segments: [
        {
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "念",
          options: { praise: "  " },
        },
      ],
    });
    expect(empty.segments[0].options).toBeNull();
  });
});

describe("AdventureScriptImportService", () => {
  let service: AdventureScriptImportService;
  let prisma: { adventureEpisode: { findMany: jest.Mock } };
  let llm: { complete: jest.Mock };
  let query: { checkContent: jest.Mock };

  beforeEach(async () => {
    prisma = {
      adventureEpisode: { findMany: jest.fn().mockResolvedValue([]) },
    };
    llm = { complete: jest.fn() };
    query = { checkContent: jest.fn().mockResolvedValue(EMPTY_LINT) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureScriptImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: LlmService, useValue: llm },
        { provide: AdventureContentQueryService, useValue: query },
      ],
    }).compile();

    service = module.get(AdventureScriptImportService);
    jest.clearAllMocks();
  });

  describe("nextEpisodeNumber", () => {
    it("returns max + 1 across all episodes including retired/discarded", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([
        { episodeNumber: 7 },
      ]);
      await expect(service.nextEpisodeNumber("elly")).resolves.toBe(8);
      expect(prisma.adventureEpisode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { characterKey: "elly", season: 1 } }),
      );
    });

    it("returns 1 for a fresh IP", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([]);
      await expect(service.nextEpisodeNumber("polly")).resolves.toBe(1);
    });
  });

  describe("convertDocx", () => {
    function docxBuffer(): Buffer {
      return Buffer.from("fake docx bytes");
    }

    beforeEach(() => {
      (mammoth.extractRawText as jest.Mock).mockResolvedValue({
        value: "标题\n\n旁白\n【互动·奖励】好样的",
        messages: [],
      });
      llm.complete.mockResolvedValue({
        text: JSON.stringify({
          characterKey: "polly",
          recap: "",
          segments: [{ kind: "narration", text: "旁白" }],
        }),
      });
    });

    it("extracts the title deterministically and returns a linted conversion", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([
        { episodeNumber: 2 },
      ]);
      const result = await service.convertDocx(docxBuffer());

      expect(result.content.title).toBe("标题");
      expect(result.sourceText).toBe("旁白\n【互动·奖励】好样的");
      expect(result.characterKey).toBe("polly");
      expect(result.characterDetected).toBe(true);
      expect(result.episodeNumber).toBe(3);
      expect(result.season).toBe(1);
      expect(result.lint).toEqual(EMPTY_LINT);
      expect(query.checkContent).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ title: "标题" }),
        { characterKey: "polly", season: 1, episodeNumber: 3 },
      );
    });

    it("rejects an oversized buffer", async () => {
      await expect(
        service.convertDocx(Buffer.alloc(MAX_DOCX_BYTES + 1)),
      ).rejects.toMatchObject({ message: expect.stringContaining("上限") });
    });

    it("rejects an unparseable docx", async () => {
      (mammoth.extractRawText as jest.Mock).mockRejectedValue(
        new Error("bad zip"),
      );
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining(".docx"),
      });
    });

    it("rejects an empty docx", async () => {
      (mammoth.extractRawText as jest.Mock).mockResolvedValue({
        value: "  ",
        messages: [],
      });
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining("空文档"),
      });
    });

    it("rejects when the LLM call fails", async () => {
      llm.complete.mockRejectedValue(new Error("upstream down"));
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining("重试"),
      });
    });

    it("rejects when the LLM returns empty text", async () => {
      llm.complete.mockResolvedValue({ text: "" });
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining("空结果"),
      });
    });

    it("rejects when the LLM returns invalid JSON", async () => {
      llm.complete.mockResolvedValue({ text: "你好，我是模型" });
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining("JSON"),
      });
    });

    it("passes the scene and prompt to the LLM", async () => {
      await service.convertDocx(docxBuffer());
      expect(llm.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          scene: "adventure_script_convert",
          messages: [
            expect.objectContaining({ role: "system" }),
            { role: "user", content: "旁白\n【互动·奖励】好样的" },
          ],
        }),
      );
    });

    it("rejects when mammoth yields a nullish result", async () => {
      (mammoth.extractRawText as jest.Mock).mockResolvedValue(undefined);
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining("空文档"),
      });
    });

    it("rejects when mammoth throws a non-Error value", async () => {
      (mammoth.extractRawText as jest.Mock).mockRejectedValue("boom");
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining(".docx"),
      });
    });

    it("rejects when the LLM rejects with a non-Error value", async () => {
      llm.complete.mockRejectedValue("upstream exploded");
      await expect(service.convertDocx(docxBuffer())).rejects.toMatchObject({
        message: expect.stringContaining("重试"),
      });
    });
  });
});
