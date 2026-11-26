/**
 * 承接语动作层：把「这一轮要做什么」从 7 个对话意图里拆出来。
 *
 * 意图是会话模式（free_chat / free_story / sleep_story…），filler 需要的是
 * 动作（停止、继续、讲故事、哄睡、共情…）。两者混在一起会出现「情绪优先于
 * 动作」「继续被当成讲一个」「停止被当成难过」。
 *
 * 纯函数、无 IO。模型情绪只是输入之一；拒答守卫与确定性正则是硬边界，
 * 漏检时落 neutral 比落错情绪更安全。
 */

import type { FillerEmotion } from "./filler-bank";

export type FillerAct =
  | "stop"
  | "continue"
  | "story_tell"
  | "sleep"
  | "comfort"
  | "celebrate"
  | "identity"
  | "preference"
  | "question"
  | "deferred"
  | "neutral";

export interface FillerActInput {
  asrText: string;
  intent?: string | null;
  intentSource?: string | null;
  emotion?: FillerEmotion;
  adventureDeclined?: boolean;
}

export interface FillerActResult {
  act: FillerAct;
  emotion: FillerEmotion;
}

const STORY_INTENTS = new Set([
  "english_story",
  "idiom_story",
  "free_story",
  "adventure_story",
]);

const ANGRY = /(生气|讨厌|angry)/i;
const SCARED = /(害怕|怕怕|好怕|有点怕|很怕|scared|afraid)/i;
const SAD = /(难过|伤心|哭|不开心|孤单|想妈妈|想爸爸|疼|痛|不舒服|sad|upset)/i;
const HAPPY = /(开心|高兴|太棒|耶|哈哈|好玩|兴奋|happy|yay)/i;

const EXPLICIT_EMOTION =
  /(开心|高兴|难过|伤心|害怕|生气|讨厌|兴奋|孤单|想哭|疼|痛|不舒服|sad|happy|angry|scared|afraid|upset)/i;
const REFUSAL =
  /(不要|不想|不用|别|不喜欢)|((do not|don't|dont)\s+(want|like))/i;

/** 停止：动词后必须紧跟语气词/句尾，避免「不要听写作业」误伤 */
const STOP =
  /(不要|不想|不用|别)(再)?(听|讲|说|唱|玩)((这个|那个)?故事|儿歌|歌|音乐)?(了|啦|吧|呀|啊)|^(停|停下|停止|结束|退出)|^(stop|quit|exit|no more)\b|(i\s+)?(do not|don't|dont)\s+want\s+to\s+(listen|hear)/i;

const SONG = /(儿歌|歌|音乐|催眠曲)/;
/** 换一个/再讲一个：只认听讲语境，避免「换一个玩具」误判 */
const NEW_STORY =
  /(不想|不要|不)(听|讲).{0,10}(换|再|另)(一?个|一?篇)|(换|另).{0,3}(故事|story)|(再|另)(讲|来|说)(一?个|一?篇)|讲(个|一个)?别的|我要听(一个|个)?(新|别的)?故事/;

const CONTINUE =
  /^(继续|接着讲|接着来|然后呢|后来呢|往下讲)|^(continue|go on|keep going)\b/i;

const IDENTITY = /你(叫什么|是谁|是干什么的)|你的名字|who are you|your name/i;
const PREFERENCE = /你(最?(喜欢|爱)|喜欢什么|爱吃什么|平时喜欢)/i;
const QUESTION =
  /[?？]|吗[。！!…]*$|为什么|怎么|是什么|是谁|哪里|哪儿|多少|几点/;

function keywordEmotion(asrText: string): FillerEmotion {
  if (ANGRY.test(asrText)) return "angry";
  if (SCARED.test(asrText)) return "scared";
  if (SAD.test(asrText)) return "sad";
  if (HAPPY.test(asrText)) return "happy";
  return "neutral";
}

/** 换一个新故事（不是退出，也不是歌曲切换）；会话层与 filler 共用同一口径 */
export function isStorySwitchRequest(asrText: string): boolean {
  const isSongSwitch = SONG.test(asrText) && !/故事/.test(asrText);
  return !isSongSwitch && NEW_STORY.test(asrText);
}

/**
 * 模型情绪优先；但拒绝类语句没有明确情绪词时一律归 neutral。
 * 这是「漏检落 neutral」的代码级保证，不依赖 prompt 是否已发版。
 */
function guardEmotion(asrText: string, emotion?: FillerEmotion): FillerEmotion {
  const resolved = emotion ?? keywordEmotion(asrText);
  if (REFUSAL.test(asrText) && !EXPLICIT_EMOTION.test(asrText)) {
    return "neutral";
  }
  return resolved;
}

export function resolveFillerAct(input: FillerActInput): FillerActResult {
  const asrText = input.asrText;
  const intent = input.intent ?? null;
  const source = input.intentSource ?? null;
  const emotion = guardEmotion(asrText, input.emotion);

  // 家长强制哄睡优先于一切，包括孩子的停止与换故事
  if (source === "force_sleep" || source === "test_sleep") {
    return { act: "sleep", emotion };
  }

  // 「换一个」是换一个新故事，不是退出；歌曲切换不在此列
  if (isStorySwitchRequest(asrText)) {
    return { act: "story_tell", emotion };
  }

  if (source === "explicit_exit") {
    return { act: "stop", emotion };
  }
  if (STOP.test(asrText)) {
    return { act: "stop", emotion };
  }
  // 冒险/哄睡门禁拦截时不能承诺「接着讲」，先落 deferred 再判继续
  if (input.adventureDeclined) {
    return { act: "deferred", emotion };
  }
  if (source === "sleep_window_closed") {
    return { act: "deferred", emotion };
  }
  if (source === "continuation" || CONTINUE.test(asrText)) {
    return { act: "continue", emotion };
  }
  if (intent === "sleep_story") {
    return { act: "sleep", emotion };
  }
  if (intent !== null && STORY_INTENTS.has(intent)) {
    return { act: "story_tell", emotion };
  }
  if (emotion === "sad" || emotion === "angry" || emotion === "scared") {
    return { act: "comfort", emotion };
  }
  if (emotion === "happy") {
    return { act: "celebrate", emotion };
  }
  if (IDENTITY.test(asrText)) {
    return { act: "identity", emotion };
  }
  if (PREFERENCE.test(asrText)) {
    return { act: "preference", emotion };
  }
  if (QUESTION.test(asrText)) {
    return { act: "question", emotion };
  }
  return { act: "neutral", emotion };
}
