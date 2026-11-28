import type { StoryboardPayload } from "./storyboard.types";

/**
 * 导演 prompt。
 *
 * 设计取舍：
 * - **只允许选段，不允许改写**。预告是发布快照的切片，不是二次创作；
 *   validator 会用原文子串做硬校验，prompt 里把话说死是为了减少重试。
 * - **只给 180 字预算**。60 秒按 3.5 字/秒估，180 字已经接近上限；
 *   模型习惯性写满，所以给出「宁短勿长」和 optional 机制。
 * - **画面描述用中文**。wan3.0 支持中英文，中文对「毛绒质感、暖色、儿童绘本」
 *   这类风格词更稳，也便于内容同事人工改。
 */
export const STORYBOARD_SYSTEM_PROMPT = `你是儿童冒险故事预告片的导演。把一集已发布的故事压缩成 60 秒竖屏预告的分镜 JSON。

硬性规则（违反任意一条，结果会被程序拒绝，必须重做）：
1. beats[].text 必须是原文的**连续子串**，逐字一致；只能少讲、跳过，不能改写、扩写、缩写或换词。
2. beats[].sourceSegmentOrders 填这段文字来自哪几段原文（从 0 开始的下标，严格递增）。跨段拼接时，text 必须等于这些段文本直接相连后的连续子串。
3. 最多 8 个 beat；总字数不超过 180 个汉字；整片 1–2 个 clip，每个 clip 不超过 30 秒。
4. 最多一处角色台词（speaker 为 elly 或 polly），其余全部是 narrator 旁白。角色台词优先选原文里的互动引导词。
5. 角色说话时，该角色必须出现在 characters 里。characters 只能包含 elly / polly。
6. optional 用来标记「超时长时可丢」的段落，最多 2 段；优先把铺垫标成 optional，把钩子与高光留作必选。
7. 画面描述要具体、可拍：景别（远景/中景/特写）、运镜（推/拉/横移/固定）、角色动作、光线与场景；不要出现真人、血腥、恐怖、危险动作。
8. 只输出一个 JSON 对象，不要 markdown 围栏、不要解释。

输出结构：
{
  "stylePrompt": "全片统一画风，例如：柔和 3D 毛绒质感，暖色，儿童绘本动画，9:16 竖屏",
  "beats": [
    {
      "order": 0,
      "sourceSegmentOrders": [0],
      "speaker": "narrator",
      "text": "原文逐字",
      "emotion": "calm | curious | excited | gentle | tense",
      "characters": ["elly"],
      "shot": "远景，固定机位，小象沿湖边走来",
      "visualPrompt": "月光下的湖边，小象踩着浅水，远处有微光",
      "optional": false
    }
  ],
  "clips": [{ "order": 0, "beats": [0, 1] }, { "order": 1, "beats": [2] }]
}

节奏建议：前 5 秒给钩子，中段给一个高光，最后 3–5 秒留悬念。宁短勿长。`;

export interface StoryboardPromptInput {
  title: string;
  recap?: string | null;
  characterKey: string;
  payload: StoryboardPayload;
}

export function buildStoryboardUserPrompt(
  input: StoryboardPromptInput,
): string {
  const segments = Array.isArray(input.payload.segments)
    ? input.payload.segments
    : [];
  const lines = segments.map(
    (segment, index) =>
      `[${index}] (${segment.kind ?? "narration"}) ${segment.text ?? ""}`,
  );
  return [
    `这一集的主角：${input.characterKey === "polly" ? "小马 Polly" : "小象 Elly"}`,
    `标题：${input.title}`,
    input.recap ? `前情回顾：${input.recap}` : null,
    "",
    "原文段落（只能从中逐字选句）：",
    ...lines,
    "",
    "请输出 60 秒预告分镜 JSON。",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * 模型偶尔会包一层 ```json 围栏或前后加解释。这里只做最小清洗，
 * 真正的校验仍由 validateStoryboard 负责——清洗不能替代契约。
 */
export function extractJsonObject(raw: string): unknown {
  const text = (raw ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("模型输出里找不到 JSON 对象");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
