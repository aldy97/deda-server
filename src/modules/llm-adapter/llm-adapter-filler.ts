/**
 * 流式 filler 的纯逻辑：头部校验、确定性模板、去重与兜底模板池。
 * 从 LlmAdapterService 抽出，全部为无 this 状态的纯函数，供独立单测。
 */

/** 问 Elly 身份（名字/是谁）的窄类问句：filler 走模板，不交给小模型 */
export const SELF_IDENTITY_QUESTION =
  /你(叫什么|是谁|是干什么的)|你的名字|who are you|your name/i;
/** 问 Elly 偏好的窄类问句：同上走模板（实机事故：filler 主客颠倒） */
export const SELF_PREFERENCE_QUESTION =
  /你(最?(喜欢|爱)|喜欢什么|爱吃什么|平时喜欢)/i;

// 模板池统一 ≥15 字 / ≥8 词：模板也是过渡音覆盖，同样要盖住主模型首包
export const IDENTITY_FILLERS_ZH = [
  "你在问我的名字呀，让我想一想怎么介绍自己呢……",
  "你想知道我是谁呀，这个问题还挺有意思的呢……",
];
export const PREFERENCE_FILLERS_ZH = [
  "你想知道我喜欢什么呀，让我认真想一想呢……",
  "你在问我的喜好呀，我还真想跟你好好聊聊呢……",
];
export const IDENTITY_FILLERS_EN = [
  "Oh, you are asking about my name? Let me think!",
];
export const PREFERENCE_FILLERS_EN = [
  "You want to know what I like? Let me think about it!",
];
export const GENERIC_FILLERS_ZH = [
  "嗯嗯，我在认真听呢，你接着往下说呀……",
  "哇，你说的话真有意思呀，我还想再听呢……",
  "哦？这件事听起来好有趣呀，后来呢后来呢……",
  "哈哈，我最喜欢听你说话啦，再多讲一点嘛……",
];
export const GENERIC_FILLERS_EN = [
  "Hmm, I am listening carefully, keep going!",
  "Wow, that sounds so fun, tell me more!",
  "Oh really? I want to hear more about it!",
];

/** 流式 filler 头部缓冲长度（字符）：足以定论「孩子名开头 / 人设名出现」 */
export const FILLER_HEAD_BUFFER_CHARS = 8;

/** filler 开头语气词/标点剥离集：判「孩子名开头」前先剥掉填充开场 */
export const FILLER_LEADING_FILLER_CHARS =
  /^[\s\p{P}\p{S}呀嗯啊哦哈哇噢唉嘿]+/u;

/** 归一化比对（去大小写/空白/标点/符号）：挡逐字复读与近重复 */
export function normalizeFiller(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 归一化后与最近 filler 逐字比对 */
export function isFillerDuplicate(
  text: string,
  recentFillers: string[],
): boolean {
  const normalized = normalizeFiller(text);
  return recentFillers.some((recent) => normalizeFiller(recent) === normalized);
}

/**
 * 流式 filler 头部校验：拒绝两类实机事故的头部现象
 * （剥离语气词后以孩子名开头 / 任意位置出现人设名）。
 * 缓冲不足 8 字且非终态时返回 undecided（继续等后续 chunk）。
 */
export function checkFillerHead(
  buffer: string,
  childName: string | undefined,
  personaName: string,
  final = false,
): "pass" | "reject" | "undecided" {
  const compact = buffer.replace(/\s+/g, "");
  const compactPersona = personaName.replace(/\s+/g, "");
  if (compactPersona && compact.includes(compactPersona)) {
    return "reject";
  }
  if (childName) {
    const stripped = buffer.replace(FILLER_LEADING_FILLER_CHARS, "");
    if (stripped.startsWith(childName)) {
      return "reject";
    }
  }
  return final || [...buffer].length >= FILLER_HEAD_BUFFER_CHARS
    ? "pass"
    : "undecided";
}

/**
 * 流式 filler 事后校验：已播不可撤回，违规只告警供日志/dashboard 观测。
 * （复读与长度下限的硬门让位给首音延迟，prompt 禁用清单是主防线）
 */
export function logFillerPostChecks(
  logger: { warn: (message: string) => void },
  fullText: string,
  recentFillers: string[],
  personaName: string,
): void {
  if (!fullText) {
    return;
  }
  if (isFillerDuplicate(fullText, recentFillers)) {
    logger.warn(`Filler repeated despite banned list: ${fullText}`);
  }
  const isZh = /[\u4e00-\u9fff]/.test(fullText);
  const tooShort = isZh
    ? [...fullText.replace(/[\s\p{P}\p{S}]/gu, "")].length < 15
    : fullText.trim().split(/\s+/).length < 8;
  if (tooShort) {
    logger.warn(`Filler shorter than the 15-char/8-word floor: ${fullText}`);
  }
  const compactPersona = personaName.replace(/\s+/g, "");
  if (compactPersona && fullText.replace(/\s+/g, "").includes(compactPersona)) {
    logger.warn(`Filler contains persona name beyond head check: ${fullText}`);
  }
}

/** 身份/偏好问句的确定性模板；非此类问句返回 null 走小模型 */
export function fillerTemplateFor(
  asrText: string,
  recentFillers: string[],
): string | null {
  const isZh = /[\u4e00-\u9fff]/.test(asrText);
  let pool: string[] | null = null;
  if (SELF_IDENTITY_QUESTION.test(asrText)) {
    pool = isZh ? IDENTITY_FILLERS_ZH : IDENTITY_FILLERS_EN;
  } else if (SELF_PREFERENCE_QUESTION.test(asrText)) {
    pool = isZh ? PREFERENCE_FILLERS_ZH : PREFERENCE_FILLERS_EN;
  }
  if (!pool) {
    return null;
  }
  return pool.find((f) => !isFillerDuplicate(f, recentFillers)) ?? pool[0];
}

/** 重试仍重复时的兜底：通用模板池里挑一条最近没用过的 */
export function fillerFallback(
  asrText: string,
  recentFillers: string[],
): string {
  const pool = /[\u4e00-\u9fff]/.test(asrText)
    ? GENERIC_FILLERS_ZH
    : GENERIC_FILLERS_EN;
  return pool.find((f) => !isFillerDuplicate(f, recentFillers)) ?? pool[0];
}
