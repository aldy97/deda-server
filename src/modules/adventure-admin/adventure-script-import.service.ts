import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import * as mammoth from "mammoth";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import {
  ADVENTURE_CHARACTER_KEYS,
  ADVENTURE_INTERACTION_TYPES,
  ADVENTURE_SEASON,
  AdventureCharacterKey,
  AdventureInteractionType,
  EpisodeContentDraft,
  EpisodeSegmentDraft,
  SegmentOptions,
  TwoChoiceOption,
} from "./adventure-content.types";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import { LintReport } from "./adventure-linter";

/**
 * docx 故事稿 → 结构化草稿的转换服务（只读，不落库）。
 *
 * 落库仍走 AdventureContentService.createEpisode：这里只负责「把稿子看懂」。
 * 刻意把转换与创建拆成两段（对应 dashboard 的「生成草稿 = 预览 → 存草稿 = 落库」），
 * 因为 LLM 的输出不可控——先预览让 admin 改，比一键落库后被 CONTENT_REJECTED
 * 挡回来却没有抽屉可修要好。
 *
 * 稿子的标注约定（同时写进 LLM prompt 与 dashboard 上传卡片的提示）：
 * - 正文第一个非空行 = 这一集的标题（确定性取走，不交给 LLM）；
 * - 未标注的普通段落 = 旁白（narration）；
 * - 【互动·二选一】/【互动·开放问答】/【互动·跟我念】/【互动·奖励】各自成段。
 */

/** docx 原文上限：脚本很小，5MB 已经是给错传整本书留的余量。 */
export const MAX_DOCX_BYTES = 5 * 1024 * 1024;

export interface ScriptConversion {
  characterKey: AdventureCharacterKey;
  /** false = LLM 没给白名单内主角，已回落 elly（抽屉里应提示可改） */
  characterDetected: boolean;
  season: number;
  /** 该 IP 下一集的自增集号（含已下架/已作废的集——业务键永久占用） */
  episodeNumber: number;
  content: EpisodeContentDraft;
  /** 去掉标题行后的正文，供抽屉回看原文 */
  sourceText: string;
  lint: LintReport;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 正文首个非空行是标题；其余是正文。标题行之外的空白行会被保留交给 LLM 判断段落边界。 */
export function splitTitle(text: string): { title: string; body: string } {
  const lines = text.split(/\r?\n/);
  let titleIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim().length > 0) {
      titleIndex = index;
      break;
    }
  }
  if (titleIndex === -1) {
    return { title: "", body: text };
  }
  const title = lines[titleIndex].trim();
  const body = lines
    .slice(titleIndex + 1)
    .join("\n")
    .trim();
  return { title, body };
}

/** 剥掉 LLM 偶尔套上的 ```json 围栏后 JSON.parse；解析失败抛 SCRIPT_CONVERT_FAILED。 */
export function parseLlmJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw new BadRequestException({
      message:
        "LLM 转换结果不是合法 JSON。请重试，或把稿子里的交互标注改得更贴近约定格式。",
      code: "SCRIPT_CONVERT_FAILED",
    });
  }
}

function normalizeOptions(
  raw: unknown,
  interactionType: AdventureInteractionType | null,
): SegmentOptions | null {
  if (interactionType === "two_choice") {
    const choices =
      isObject(raw) && Array.isArray(raw.choices) ? raw.choices : [];
    const normalized: TwoChoiceOption[] = choices.slice(0, 2).map((item) => {
      const choice = isObject(item) ? item : {};
      return {
        key: asString(choice.key),
        text: asString(choice.text),
        reply: asString(choice.reply),
      };
    });
    return { choices: normalized };
  }
  if (interactionType === "repeat_after_me") {
    const praise = isObject(raw) ? asString(raw.praise) : "";
    return praise ? { praise } : null;
  }
  return null;
}

function normalizeSegment(raw: unknown): EpisodeSegmentDraft | null {
  if (!isObject(raw)) {
    return null;
  }
  const kind = raw.kind === "interaction" ? "interaction" : "narration";
  const text = asString(raw.text);
  const rawType = raw.interactionType;
  const interactionType: AdventureInteractionType | null =
    kind === "interaction" &&
    typeof rawType === "string" &&
    (ADVENTURE_INTERACTION_TYPES as readonly string[]).includes(rawType)
      ? (rawType as AdventureInteractionType)
      : null;
  const fallbackText = asString(raw.fallbackText) || null;
  return {
    order: 0, // 由 normalizeScriptOutput 统一重排为 0..n-1
    kind,
    text,
    interactionType: kind === "interaction" ? interactionType : null,
    options:
      kind === "interaction"
        ? normalizeOptions(raw.options, interactionType)
        : null,
    fallbackText,
    rewardStar: raw.rewardStar === true,
  };
}

/**
 * 把 LLM 返回的 JSON 归一化成安全的草稿形状：
 * - 主角不在白名单 → 回落 elly 并标记 characterDetected=false；
 * - 段 order 一律重排 0..n-1（LLM 不保证连续）；
 * - two_choice 选项超过 2 个截断到 2 个（>2 是草稿阻断码 CHOICES_COUNT_INVALID）；
 * - kind/interactionType 不在白名单的段降级为旁白/无交互，而不是丢段——丢段会让
 *   createEpisode 的 assertNoSegmentLoss 直接拒掉整份草稿。
 */
export function normalizeScriptOutput(raw: unknown): {
  characterKey: AdventureCharacterKey;
  characterDetected: boolean;
  recap: string | null;
  segments: EpisodeSegmentDraft[];
} {
  const source = isObject(raw) ? raw : {};
  const rawKey = source.characterKey;
  const characterDetected =
    typeof rawKey === "string" &&
    (ADVENTURE_CHARACTER_KEYS as readonly string[]).includes(rawKey);
  const characterKey: AdventureCharacterKey = characterDetected
    ? (rawKey as AdventureCharacterKey)
    : "elly";
  const recap = asString(source.recap) || null;
  const rawSegments = Array.isArray(source.segments) ? source.segments : [];
  const segments = rawSegments
    .map((item) => normalizeSegment(item))
    .filter((segment): segment is EpisodeSegmentDraft => segment !== null)
    .map((segment, index) => ({ ...segment, order: index }));
  return { characterKey, characterDetected, recap, segments };
}

/**
 * 转换 prompt。中文撰写，输出契约严格枚举，与稿子标注约定逐条对齐。
 * 关键约束是「旁白/引导词逐字忠于原文、two_choice 恰好两个选项、需开口的
 * 互动必带兜底、跟我念必带表扬、reward 必带 star」——这些正是 lint 与引擎会
 * 逐条检验的字段，prompt 不写全，LLM 就会漏。
 */
const SCRIPT_CONVERT_SYSTEM_PROMPT = `你是儿童冒险故事稿的转换器。把一份带标注的中文故事稿转换成结构化 JSON。

输入稿子的标注约定（也展示给内容创作者）：
- 正文第一个非空行是这一集的标题，已经在输入前被取走，你不处理标题。
- 未标注的普通段落 = 旁白（narration）。
- 交互点用独立一行标记，四种：
  【互动·二选一】引导词 → 下面跟「选项A：…｜接话：…」「选项B：…｜接话：…」「兜底：…」
  【互动·开放问答】引导词 → 下面跟「兜底：…」
  【互动·跟我念】要念的句子 → 下面跟「表扬：…」「兜底：…」
  【互动·奖励】引导词 → 这一段发一颗星，没有兜底

只输出一个 JSON 对象，不要输出任何解释、markdown 围栏或多余文字，结构如下：
{
  "characterKey": "elly" 或 "polly",
  "recap": "可选的前情回顾，没有就空字符串",
  "segments": [
    { "kind": "narration", "text": "旁白原文" },
    { "kind": "interaction", "interactionType": "open_question", "text": "引导词", "fallbackText": "兜底" },
    { "kind": "interaction", "interactionType": "two_choice", "text": "引导词", "options": {"choices": [{"key":"A","text":"选项文案","reply":"接话"},{"key":"B","text":"选项文案","reply":"接话"}]}, "fallbackText": "兜底" },
    { "kind": "interaction", "interactionType": "repeat_after_me", "text": "要念的句子", "options": {"praise": "表扬"}, "fallbackText": "兜底" },
    { "kind": "interaction", "interactionType": "reward", "text": "引导词", "rewardStar": true }
  ]
}

硬性约束：
1. segments 必须按稿子原文顺序排列；一段旁白 = 一段 narration，一个【互动·xxx】= 一段 interaction。
2. 旁白 text 与互动引导词 text 必须逐字忠于原文，不要改写、扩写或删减。
3. two_choice 必须恰好两个选项（key 固定 A、B）；reply 是孩子选中后立刻听到的接话句。
4. 需要孩子开口的互动（open_question / two_choice / repeat_after_me）必须带 fallbackText（孩子跑题、沉默时说的话）。
5. repeat_after_me 必须带 praise（孩子念对后的鼓励）。
6. reward 段 rewardStar 必须为 true。
7. 主角识别：通读全文判断这集主角是 elly（小象 Elly）还是 polly（小马 Polly），填进 characterKey；全文没有明确指向时默认 "elly"。`;

@Injectable()
export class AdventureScriptImportService {
  private readonly logger = new Logger(AdventureScriptImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly query: AdventureContentQueryService,
  ) {}

  /** 把一份 docx 稿子转换成「可预览的草稿」：标题 + 主角 + 自增集号 + 段落 + lint。 */
  async convertDocx(buffer: Buffer): Promise<ScriptConversion> {
    if (buffer.length > MAX_DOCX_BYTES) {
      throw new BadRequestException({
        message: `docx 超过 ${Math.floor(MAX_DOCX_BYTES / 1024 / 1024)}MB 上限，请精简后重试。`,
        code: "DOCX_TOO_LARGE",
      });
    }
    const text = await this.extractDocxText(buffer);
    const { title, body } = splitTitle(text);
    const script = await this.convertScript(body);
    const season = ADVENTURE_SEASON;
    const episodeNumber = await this.nextEpisodeNumber(script.characterKey);
    const content: EpisodeContentDraft = {
      title,
      recap: script.recap,
      segments: script.segments,
    };
    const identity = {
      characterKey: script.characterKey,
      season,
      episodeNumber,
    };
    // 按草稿标准算一次 lint：admin 一进抽屉就能看到「哪些还没写全」，不用再点一次校验。
    const lint = await this.query.checkContent(null, content, identity);
    return {
      characterKey: script.characterKey,
      characterDetected: script.characterDetected,
      season,
      episodeNumber,
      content,
      sourceText: body,
      lint,
    };
  }

  /**
   * 该 IP 下一集的自增集号。查询不过滤 retiredAt：业务键一旦占用即永久占用，
   * 已下架/已作废的集也必须算进 max，否则会撞唯一约束把集号烧掉。
   */
  async nextEpisodeNumber(
    characterKey: AdventureCharacterKey,
  ): Promise<number> {
    const rows = await this.prisma.adventureEpisode.findMany({
      where: { characterKey, season: ADVENTURE_SEASON },
      orderBy: { episodeNumber: "desc" },
      take: 1,
      select: { episodeNumber: true },
    });
    const max = rows.length > 0 ? rows[0].episodeNumber : 0;
    return max + 1;
  }

  private async extractDocxText(buffer: Buffer): Promise<string> {
    let text: string;
    try {
      const result = await mammoth.extractRawText({ buffer });
      text = (result?.value ?? "").trim();
    } catch (error) {
      this.logger.warn(
        `docx 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException({
        message:
          "无法解析这个 docx（可能是损坏文件或旧版 .doc 格式）。请转成 .docx 后重试。",
        code: "DOCX_UNPARSEABLE",
      });
    }
    if (!text) {
      throw new BadRequestException({
        message: "docx 里没有正文。请确认稿子不是空文档。",
        code: "DOCX_UNPARSEABLE",
      });
    }
    return text;
  }

  private async convertScript(body: string): Promise<{
    characterKey: AdventureCharacterKey;
    characterDetected: boolean;
    recap: string | null;
    segments: EpisodeSegmentDraft[];
  }> {
    let rawText: string;
    try {
      const result = await this.llm.complete({
        scene: "adventure_script_convert",
        messages: [
          { role: "system", content: SCRIPT_CONVERT_SYSTEM_PROMPT },
          { role: "user", content: body },
        ],
        temperature: 0.2,
        maxTokens: 8000,
        thinking: { type: "disabled" },
      });
      rawText = result.text;
    } catch (error) {
      this.logger.warn(
        `LLM 转换调用失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadRequestException({
        message: "LLM 转换调用失败，请重试。",
        code: "SCRIPT_CONVERT_FAILED",
      });
    }
    if (!rawText.trim()) {
      throw new BadRequestException({
        message: "LLM 转换返回了空结果，请重试。",
        code: "SCRIPT_CONVERT_FAILED",
      });
    }
    return normalizeScriptOutput(parseLlmJson(rawText));
  }
}
