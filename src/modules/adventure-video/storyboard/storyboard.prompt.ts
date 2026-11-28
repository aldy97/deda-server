import type { StoryboardPayload } from "./storyboard.types";

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
