/**
 * Filler 模板池：生产 filler 的唯一来源。
 *
 * 只承接「孩子在跟我说话」和情绪，不复述孩子说的具体内容。
 * 动作（停止 / 继续 / 讲故事 / 哄睡 / 共情…）由 filler-act 判定，
 * 这里只负责按 act 选语言与桶；桶内句子由最近 10 轮过滤 + turnId
 * 哈希轮转决定，任何一步都不调用 LLM。
 */

import { resolveFillerAct, type FillerAct } from "./filler-act";

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
  | "stop"
  | "continue"
  | "en_neutral"
  | "en_question"
  | "en_story"
  | "en_comfort"
  | "en_celebrate"
  | "en_stop"
  | "en_continue";

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
    "好呀，我给你讲一个，你躺好慢慢听呀……",
    "嗯，故事这就来啦，我们轻轻开始听呀……",
    "好，我讲你听，你闭上眼睛跟着我走呀……",
    "我把声音放轻啦，讲一个短短的故事呀……",
    "好呀，那小耳朵准备好，故事要开始啦……",
    "嗯，我给你讲个新的，你慢慢听我讲呀……",
    "好呀，故事来啦，我们安安静静听着呀……",
    "我把小灯调暗啦，慢慢给你讲个故事呀……",
    "嗯，你坐好啦，我这就慢慢讲给你听呀……",
    "好，故事开头啦，你跟着我慢慢往下听呀……",
    "嗯，我把声音放得软软的，给你讲故事呀……",
    "好嘞，我给你讲一个暖暖的小故事呀……",
    "嗯，故事准备好了，你安安静静听着呀……",
    "好，我慢慢讲，你慢慢听，我们不着急呀……",
    "好啦，故事这就开始啦，你跟着我走吧……",
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
  stop: [
    "好呀，那我们先不听了，我就在这儿陪着你呀……",
    "嗯，停下来也没关系，我安安静静陪着你呀……",
    "好，那我们把声音关小一点，歇一会儿呀……",
    "嗯，不听了就不听了，我陪着你休息一下呀……",
    "好呀，我们休息一下，我一直在你旁边呢……",
    "嗯，那就不听啦，我轻轻陪着你待一会儿呀……",
    "好，停下来吧，我们安安静静靠一会儿呀……",
    "嗯，不听也没关系，我就在这儿守着你呀……",
    "好啦，那我们歇一歇，我慢慢陪着你呢……",
    "嗯，先不听了，我们一起慢慢松一口气呀……",
    "好，那就不讲啦，我安安静静陪着你呀……",
    "嗯，歇一会儿也好，我们慢慢放松一下呀……",
    "好呀，不听了不听了，我就在这儿陪你呀……",
    "嗯，那我们先安静下来，我慢慢陪着你呢……",
    "好，我们先把声音关掉，慢慢歇一会儿呀……",
  ],
  continue: [
    "好呀，我们接着刚才的往下讲，你别着急呀……",
    "嗯，故事还没完呢，我们慢慢接着讲呀……",
    "好，接着刚才的往下说，我慢慢讲给你呀……",
    "嗯，我们继续往下讲，你安安静静听着呀……",
    "好呀，接下来还有呢，我们接着往下走呀……",
    "嗯，刚才讲到哪儿啦，我们接着往下说呀……",
    "好，故事还长着呢，我们慢慢接着听呀……",
    "嗯，别着急，我们慢慢接着往下讲就好呀……",
    "来呀，我们接着说，你跟着我慢慢听呀……",
    "嗯，还没讲完呢，我们一点一点接着来呀……",
    "好，那我们就接着往下讲，你慢慢听呀……",
    "嗯，那我们就继续往下讲，慢慢说着呀……",
    "好呀，接着往下讲啦，你安安静静听呀……",
    "嗯，我们接着说下去，不急不慢地讲呀……",
    "好，故事继续啦，我们一起慢慢往下听呀……",
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
    "Okay, here comes a story, snuggle in and listen!",
    "Hmm, I will tell you a story, let us begin!",
    "Right, a little story is coming, listen closely!",
    "Oh, I have a story for you, sit comfortably!",
    "Well, let me tell you a story, here we go!",
    "Now, I will begin the story, listen carefully!",
    "Okay, the story starts now, just follow me!",
    "Oh my, I will speak softly and tell a story!",
    "Oh, a cozy story is ready, here it comes!",
    "Right, snuggle up, and I will tell a story!",
    "So, I will tell you a new story now!",
    "Here we go, a little story just for you!",
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
  en_stop: [
    "Okay, we can stop now, I am right here with you.",
    "Hmm, we can rest now, I am staying right here.",
    "Right, no more listening, I am here beside you.",
    "Oh, we can stop, and I will stay with you.",
    "Well, we can take a break, I am right here.",
    "Now, let us stop and rest, I am here with you.",
    "Alright, we will pause now, I am right beside you.",
    "Hmm, that is okay, we can rest for a while.",
    "Oh, no more for now, I will stay right here.",
    "Right, we can stop here, and I am with you.",
    "So, let us take a little rest, I am here.",
    "Here we are, all quiet now, I am with you.",
  ],
  en_continue: [
    "Okay, let us keep going with the story now.",
    "Hmm, the story is not over, let us continue.",
    "Right, we will carry on from where we stopped.",
    "Oh, there is more to come, let us keep listening.",
    "Well, we can go on, the story is still here.",
    "Now, let us continue, and I will keep telling.",
    "Okay, we will go on, just follow my voice.",
    "Hmm, let us carry on, nice and slow now.",
    "Oh, the story continues, let us go on now.",
    "True, we are not done yet, let us continue.",
    "So, let us keep going, nice and slowly now.",
    "Here we go again, the story will go on.",
  ],
};

function detectLanguage(text: string): "zh" | "en" {
  const hasCjk = /[\u4e00-\u9fff]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  return !hasCjk && hasLatin ? "en" : "zh";
}

function bucketForAct(act: FillerAct, lang: "zh" | "en"): FillerBucket {
  if (lang === "en") {
    switch (act) {
      case "stop":
        return "en_stop";
      case "continue":
        return "en_continue";
      case "story_tell":
      case "sleep":
        return "en_story";
      case "comfort":
        return "en_comfort";
      case "celebrate":
        return "en_celebrate";
      case "identity":
      case "preference":
      case "question":
        return "en_question";
      default:
        return "en_neutral";
    }
  }
  switch (act) {
    case "stop":
      return "stop";
    case "continue":
      return "continue";
    case "story_tell":
      return "story";
    case "sleep":
      return "sleep";
    case "comfort":
      return "comfort";
    case "celebrate":
      return "celebrate";
    case "identity":
      return "identity";
    case "preference":
      return "preference";
    case "question":
      return "question";
    default:
      return "neutral";
  }
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
  /** 会话状态机来源；explicit_exit / continuation 等直接决定动作 */
  intentSource?: string | null;
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
  act: FillerAct;
} {
  const lang = detectLanguage(input.asrText);
  const { act, emotion } = resolveFillerAct(input);
  const bucket = bucketForAct(act, lang);
  return {
    text: pickFromPool(
      FILLER_POOLS[bucket],
      input.turnId,
      input.recentFillers,
      lang,
    ),
    bucket,
    emotion,
    act,
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
