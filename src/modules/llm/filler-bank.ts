/**
 * Filler 模板池：生产 filler 的唯一来源。
 *
 * 只承接「孩子在跟我说话」和情绪，不复述孩子说的具体内容。
 * 桶由已算好的 intent、冒险门禁和确定性正则决定；桶内句子由
 * 最近 10 轮过滤 + turnId 哈希轮转决定，任何一步都不调用 LLM。
 */

export type FillerEmotion = "neutral" | "happy" | "sad" | "angry" | "scared";

export const FILLER_EMOTIONS: readonly FillerEmotion[] = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "scared",
];

export type FillerBucket =
  | "neutral"
  | "question"
  | "story"
  | "sleep"
  | "comfort"
  | "celebrate"
  | "identity"
  | "preference"
  | "en_neutral"
  | "en_question"
  | "en_story"
  | "en_comfort"
  | "en_celebrate";

export const FILLER_POOLS: Record<FillerBucket, readonly string[]> = {
  neutral: [
    "嗯嗯，我在认真听呢，你愿意跟我说真好呀……",
    "我在这儿呢，你慢慢讲，我真的不着急呀……",
    "听你说话真好，我还想再多听一点点呢……",
    "你愿意跟我说话，我心里特别暖暖的呢……",
    "我在认真听呢，你的声音让我觉得很开心……",
    "嗯，你说的每句话，我都认认真真听着呢……",
    "我一直在听呢，你想说什么都可以呀……",
    "你跟我说话的时候，我特别特别专心呢……",
    "嗯嗯，我听见啦，再多跟我说一点点呀……",
    "我最喜欢听你说话了，再多讲一点呀……",
    "我听着呢，你慢慢说，我一点不着急呀……",
    "你慢慢说呀，我就在这儿一直陪着你呢……",
    "嗯，我在这儿陪着你，想说什么都可以呀……",
    "听你讲话的时候，我心里觉得暖暖的呢……",
    "我在呢，你说的每句话我都认真听着呢……",
  ],
  question: [
    "嗯，这个问题我得好好想一想再答呀……",
    "哦，你问的这个，我想认真想一想再答呀……",
    "这问题有点意思，让我慢慢想一想呢……",
    "嗯，我得把脑袋慢慢转一转，再告诉你呀……",
    "嗯，我先想一想哦，想好了就告诉你呀……",
    "这个问题我要认真想一下，你等我一下下呀……",
    "哦，我想一想，慢慢想清楚再跟你说呀……",
    "嗯，让我把小脑袋转一转，马上就想好啦……",
    "嗯，这个我要好好琢磨一下，再告诉你呀……",
    "哦，这个我得认真想一想，再慢慢告诉你呀……",
    "嗯，我先在心里想一遍，想好了就说呀……",
    "这题有点难，我要多想一想再回答呀……",
    "嗯，我认真想想哦，想明白了就告诉你呀……",
    "哦，让我慢慢想一想，不着急告诉你呀……",
    "嗯，我要转转眼珠，好好想一想再答呀……",
  ],
  story: [
    "好呀，我先把小耳朵准备好，安安静静听你安排呢……",
    "嗯，我把声音放轻一点，慢慢陪你进故事里呀……",
    "好，我坐好啦，等你一说开始，我们就出发呀……",
    "嗯嗯，我准备好了，你一说我们就开始呀……",
    "我把小毯子盖好，安安静静等你开口呢……",
    "嗯，我乖乖坐好啦，慢慢听你的安排呀……",
    "我把灯调得暗一点点，慢慢陪着你呢……",
    "嗯，我已经准备好啦，你说开始就开始呀……",
    "好，我把小手放好，安安静静等你讲故事呀……",
    "嗯，我坐好准备啦，你慢慢说，我认真听呀……",
    "我把小耳朵竖起来啦，等你的故事呀……",
    "嗯，我坐得稳稳的，等你带我去故事里呀……",
    "好呀，我把声音放得轻轻的，慢慢听你说呀……",
    "嗯，我准备好啦，你什么时候开始都可以呀……",
    "好，我安安静静坐好，等你讲故事给我听呀……",
  ],
  sleep: [
    "好呀，我把声音放轻一点，慢慢陪着你呀……",
    "嗯，我们慢慢来，不着急，我一直陪着你呀……",
    "我把小声音收得轻轻的，慢慢陪着你呀……",
    "嗯，我轻轻的，慢慢的，会一直陪着你呢……",
    "好，我们安安静静的，慢慢把眼睛闭上呀……",
    "我把声音放得软软的，陪你慢慢安静下来呀……",
    "好呀，不急不急，我陪你慢慢地睡着呀……",
    "嗯，我在这儿呢，声音轻轻的，陪着你呀……",
    "我们一起把小灯关上，安安静静躺好呀……",
    "嗯，我慢慢说，你慢慢听，困了就闭上眼呀……",
    "我把小灯关好啦，我们安安静静躺好呀……",
    "嗯，我陪你慢慢闭上眼睛，好好休息呀……",
    "声音放得低低的，我慢慢陪着你休息呀……",
    "嗯，我们轻轻的，慢慢的，一起安静下来呀……",
    "我在这儿陪着你，慢慢把眼睛闭上呀……",
  ],
  comfort: [
    "难过的时候我陪着你呢，你慢慢跟我说呀……",
    "嗯，我在这儿呢，害怕的时候可以跟我说呀……",
    "我陪着你呢，不开心的时候也可以告诉我呀……",
    "嗯，不着急，我安安静静陪着你，等你慢慢说呀……",
    "我在呢，你想哭就哭一会儿，我陪着你呀……",
    "嗯，我听着呢，心里难受的时候跟我说说呀……",
    "慢慢呼吸，慢慢说，我陪着你，不着急呀……",
    "你想说就说，不想说也没关系，我陪着你呀……",
    "生气的时候也可以慢慢告诉我，我陪着你呀……",
    "嗯，别怕，我就在这儿，会一直陪着你呀……",
    "我在这儿陪着你呢，难受的时候跟我说呀……",
    "嗯，我陪着你呢，想哭就哭一会儿也没关系呀……",
    "你慢慢说，我一直在听，一点也不着急呀……",
    "嗯嗯，我听见啦，不开心的时候我陪着你呀……",
    "我在呢，害怕也好，生气也好，都可以跟我说呀……",
  ],
  celebrate: [
    "哇，听你这么说，我也跟着开心起来啦……",
    "嗯嗯，我听见啦，你的开心都传到我这里来啦……",
    "哇，真好呀，我跟你一起高兴一会儿呢……",
    "嗯，我感受到啦，你的开心让我也暖暖的呢……",
    "哈哈，我也好开心呀，你再跟我说说呀……",
    "你的开心把我照亮啦，我陪你再高兴一会儿呀……",
    "我听出来啦，你现在心里特别亮亮的呢……",
    "真好呀，我跟你一起开心，一起笑一会儿呢……",
    "哇，我也跟着乐啦，你再跟我多说一点点呀……",
    "嗯，你的好消息让我也跟着开心起来啦……",
    "哇，我听见你的开心啦，我也笑起来了呢……",
    "嗯嗯，你的开心我收到啦，我也暖暖的呢……",
    "哈哈，我跟着你一起开心，一起笑一会儿呀……",
    "哇，你的好消息让我也跟着高兴起来啦……",
    "嗯，我听出来啦，你现在一定笑眯眯的呢……",
  ],
  identity: [
    "你在问我的名字呀，让我想一想怎么介绍自己呢……",
    "你想知道我是谁呀，这个问题还挺有意思的呢……",
    "哦，你在问我是谁呀，我好好想一想再告诉你呢……",
    "嗯，你想认识我呀，我认真想想怎么跟你说呢……",
    "你问我的名字呀，我慢慢想一下再告诉你呢……",
    "嗯，你想知道我是谁呀，让我好好想一想呢……",
    "你问我名字呀，我好好想一想再告诉你呢……",
    "嗯，你在问我是谁呀，我慢慢想一想呢……",
    "你想认识我呀，我认真想一想怎么介绍自己呢……",
    "问我是谁呀，我好好想一想再回答你呢……",
    "想知道我的名字呀，让我慢慢想一想呢……",
    "你问我是谁呀，我认真想一想再告诉你呢……",
  ],
  preference: [
    "你想知道我喜欢什么呀，让我认真想一想呢……",
    "你在问我的喜好呀，我还真想跟你好好聊聊呢……",
    "哦，你想知道我喜欢什么呀，我慢慢想一想呢……",
    "嗯，你问我喜欢什么呀，我认真想想再告诉你呢……",
    "你问我的喜好呀，我好好想一想再跟你说呢……",
    "嗯，你想知道我喜欢什么呀，让我想一想呢……",
    "你问我喜欢什么呀，我好好想一想再告诉你呢……",
    "嗯，你在问我喜欢什么呀，我慢慢想一想呢……",
    "想知道我爱吃什么呀，让我认真想一想呢……",
    "问到我爱吃什么呀，我好好想一想再告诉你呢……",
    "你喜欢什么呀，你问我这个，我慢慢想一想呢……",
    "你问我爱吃什么呀，我好好想一想再告诉你呢……",
  ],
  en_neutral: [
    "I am right here, listening to you carefully, keep going!",
    "Hmm, I am listening carefully, tell me a little more!",
    "Oh, I love hearing you talk, please keep telling me more!",
    "Wow, I am right here with you, take your time!",
    "Hey, I am all ears, you can tell me anything you like!",
    "You know, I am so happy you are talking to me!",
    "Hmm, right here with you, and I am listening!",
    "Okay, take your time, I am listening to every word!",
    "Listening carefully, I am right here with you!",
    "So, I am right here with you, tell me more!",
    "Here I am, right beside you, listening carefully!",
    "Just take your time, I am right here with you!",
  ],
  en_question: [
    "Hmm, that is a good question, let me think for a moment!",
    "Oh, let me think about that for a little while!",
    "Well, I need a moment to think, then I will tell you!",
    "That is interesting, let me think it through carefully!",
    "Okay, I am thinking about it, give me a tiny moment!",
    "Let me turn it over in my head for a moment!",
    "What a fun one, let me think about it!",
    "Hmm, I am thinking hard, just a little moment!",
    "Give me a moment, I am thinking carefully!",
    "Oh, I need a tiny moment, then I will answer!",
    "Right, let me think about that for a moment!",
    "So, I need a little moment to think!",
  ],
  en_story: [
    "Okay, I am comfy and ready, take your time!",
    "Oh, I am all cozy, I cannot wait to listen!",
    "Hmm, I am ready, whenever you want to start!",
    "Right, I am sitting still and ready to listen!",
    "Wow, I am comfy, and I am listening carefully!",
    "So, I am ready, you can start whenever you like!",
    "I am cozy and quiet, ready for a story!",
    "Hey, I am settled in, and I am all ears!",
    "Well, I am comfy and quiet, ready when you are!",
    "Now, I am all ready, so take your time!",
    "Here I am, comfy and ready for a story!",
    "Just say when, and I am all ready to listen!",
  ],
  en_comfort: [
    "I am right here with you, take your time and tell me.",
    "Hmm, I am here with you, you can tell me anything.",
    "Oh, I am staying right here, take your time.",
    "Right here with you, and I am listening carefully.",
    "Hmm, it is okay, I am here with you.",
    "Oh, you can tell me, I am right here.",
    "Here with you, and I am listening carefully.",
    "Hmm, take a breath, I am right here with you.",
    "Take your time, I am right here with you.",
    "Oh, it is okay, I am staying right here with you.",
    "So, I am right here with you, tell me.",
    "Just take your time, I am here with you.",
  ],
  en_celebrate: [
    "Yay, that makes me so happy, I am listening!",
    "Oh, I am so happy for you, tell me more!",
    "Wow, that is wonderful, I am smiling with you!",
    "Yay, I feel happy too, keep telling me!",
    "Oh, your happy news makes me happy too!",
    "Wow, I am cheering with you, tell me more!",
    "So glad, I am listening carefully to you!",
    "Oh, that is lovely, I am happy with you!",
    "That is so happy, tell me all about it!",
    "Yay, your happy smile makes me smile too!",
    "Here I am, smiling with you, tell me more!",
    "Just so happy for you, keep telling me!",
  ],
};

const STORY_INTENTS = new Set([
  "english_story",
  "idiom_story",
  "free_story",
  "adventure_story",
]);

const COMFORT_ANGRY = /(生气|讨厌)/;
const COMFORT_SCARED = /(害怕|怕怕|好怕|有点怕|很怕)/;
const COMFORT_SAD = /(难过|伤心|哭|不开心|孤单|想妈妈|想爸爸|疼|痛|不舒服)/;
const CELEBRATE = /(开心|高兴|太棒|耶|哈哈|好玩|兴奋)/;
const QUESTION =
  /[?？]|吗[。！!…]*$|为什么|怎么|是什么|是谁|哪里|哪儿|多少|几点/;
const SELF_IDENTITY_QUESTION =
  /你(叫什么|是谁|是干什么的)|你的名字|who are you|your name/i;
const SELF_PREFERENCE_QUESTION = /你(最?(喜欢|爱)|喜欢什么|爱吃什么|平时喜欢)/i;

function detectLanguage(text: string): "zh" | "en" {
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  return !hasCjk && hasLatin ? "en" : "zh";
}

function resolveEmotion(input: {
  asrText: string;
  emotion?: FillerEmotion;
}): FillerEmotion {
  if (input.emotion) {
    return input.emotion;
  }
  if (COMFORT_ANGRY.test(input.asrText)) return "angry";
  if (COMFORT_SCARED.test(input.asrText)) return "scared";
  if (COMFORT_SAD.test(input.asrText)) return "sad";
  if (CELEBRATE.test(input.asrText)) return "happy";
  return "neutral";
}

function resolveBucket(
  input: {
    asrText: string;
    intent?: string | null;
    adventureDeclined?: boolean;
  },
  emotion: FillerEmotion,
  lang: "zh" | "en",
): FillerBucket {
  if (emotion === "sad" || emotion === "angry" || emotion === "scared") {
    return lang === "en" ? "en_comfort" : "comfort";
  }
  if (emotion === "happy") {
    return lang === "en" ? "en_celebrate" : "celebrate";
  }
  if (input.adventureDeclined) {
    return lang === "en" ? "en_neutral" : "neutral";
  }
  const intent = input.intent ?? "";
  if (intent === "sleep_story") {
    return lang === "en" ? "en_story" : "sleep";
  }
  if (STORY_INTENTS.has(intent)) {
    return lang === "en" ? "en_story" : "story";
  }
  if (lang === "en") {
    return QUESTION.test(input.asrText) ? "en_question" : "en_neutral";
  }
  if (SELF_IDENTITY_QUESTION.test(input.asrText)) return "identity";
  if (SELF_PREFERENCE_QUESTION.test(input.asrText)) return "preference";
  if (QUESTION.test(input.asrText)) return "question";
  return "neutral";
}

export function normalizeFiller(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function openerKey(text: string, lang: "zh" | "en"): string {
  if (lang === "en") {
    return text
      .toLowerCase()
      .replace(/[^a-z' ]/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .join(" ");
  }
  return normalizeFiller(text).slice(0, 4);
}

function hashString(text: string): number {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickFromPool(
  pool: readonly string[],
  turnId: string,
  recentFillers: string[],
  lang: "zh" | "en",
): string {
  const recentNormalized = new Set(recentFillers.map(normalizeFiller));
  const recentOpeners = new Set(
    recentFillers.map((filler) => openerKey(filler, lang)),
  );
  const candidates = pool.filter(
    (line) =>
      !recentNormalized.has(normalizeFiller(line)) &&
      !recentOpeners.has(openerKey(line, lang)),
  );
  if (candidates.length > 0) {
    return candidates[hashString(turnId) % candidates.length];
  }
  return (
    pool.find((line) => !recentNormalized.has(normalizeFiller(line))) ??
    pool[hashString(turnId) % pool.length]
  );
}

export interface FillerPickInput {
  asrText: string;
  intent?: string | null;
  adventureDeclined?: boolean;
  turnId: string;
  recentFillers: string[];
  /** 模型情绪优先；缺省时走确定性关键词 */
  emotion?: FillerEmotion;
}

export function pickFillerLine(input: FillerPickInput): {
  text: string;
  bucket: FillerBucket;
  emotion: FillerEmotion;
} {
  const lang = detectLanguage(input.asrText);
  const emotion = resolveEmotion(input);
  const bucket = resolveBucket(input, emotion, lang);
  return {
    text: pickFromPool(
      FILLER_POOLS[bucket],
      input.turnId,
      input.recentFillers,
      lang,
    ),
    bucket,
    emotion,
  };
}

export function isFillerDuplicate(
  text: string,
  recentFillers: string[],
): boolean {
  const normalized = normalizeFiller(text);
  return recentFillers.some((recent) => normalizeFiller(recent) === normalized);
}

export function extractRecentFillers(
  rows: Array<{ rawPayload: unknown }>,
  limit = 10,
): string[] {
  const fillers: string[] = [];
  for (const row of rows) {
    const filler = (row.rawPayload as { filler?: unknown } | null)?.filler;
    if (typeof filler === "string" && filler.length > 0) {
      fillers.push(filler);
    }
    if (fillers.length >= limit) {
      break;
    }
  }
  return fillers.reverse();
}
