import { readFile, stat } from "fs/promises";
import { join } from "path";
import axios from "axios";
import { PrismaClient } from "@prisma/client";
import {
  buildCreateVoiceBody,
  parseCreatedVoiceId,
  parseVoiceStatus,
  toAudioDataUri,
} from "../src/modules/adventure-video/tools/voice-enrollment";

/**
 * 三条角色音色的复刻脚本（一次性运维动作，不参与请求链路）。
 *
 * TODO(voice-samples): 样本到位后执行本脚本，然后把部署配置 VIDEO_TTS_MODE
 * 切到 cloned。样本要求：10–20 秒（最长 60 秒）、wav/mp3/m4a、≥16kHz、
 * 单声道/双声道均可、无 BGM 与其他人声；文件放 local-assets/voices/，
 * 命名 elly / polly / narrator + 扩展名。该目录已被 .gitignore 忽略。
 *
 * 合规：只能复刻已取得书面授权的音色；授权文件不要入库，由熊总线下保管。
 */

const ROLES = ["elly", "polly", "narrator"] as const;
type Role = (typeof ROLES)[number];
const EXTENSIONS = ["wav", "mp3", "m4a"];
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少配置：${name}`);
  return value;
}

function baseUrl(workspaceId: string): string {
  return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com`;
}

async function findSample(dir: string, role: Role): Promise<string | null> {
  for (const ext of EXTENSIONS) {
    const path = join(dir, `${role}.${ext}`);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (info.size > MAX_SAMPLE_BYTES) {
        throw new Error(`${path} 超过 10MB`);
      }
      return path;
    } catch {
      // 文件不存在就试下一个扩展名
    }
  }
  return null;
}

async function createVoice(input: {
  apiBase: string;
  apiKey: string;
  model: string;
  role: Role;
  audioPath: string;
  dryRun: boolean;
}): Promise<string> {
  const buffer = await readFile(input.audioPath);
  const body = buildCreateVoiceBody({
    targetModel: input.model,
    prefix: `adv${input.role}`,
    audioDataUri: toAudioDataUri(buffer, input.audioPath),
    languageHints: ["zh"],
    maxPromptAudioLengthSec: 20,
  });
  if (input.dryRun) {
    console.log(
      `[dry-run] ${input.role}: ${body.input.prefix} → ${input.model}（${buffer.length} 字节）`,
    );
    return "dry-run";
  }
  const response = await axios.post(
    `${input.apiBase}/api/v1/services/audio/tts/customization`,
    body,
    {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
    },
  );
  return parseCreatedVoiceId(response.data);
}

async function waitForReady(input: {
  apiBase: string;
  apiKey: string;
  voiceId: string;
}): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await axios.post(
      `${input.apiBase}/api/v1/services/audio/tts/customization`,
      {
        model: "voice-enrollment",
        input: { action: "query_voice", voice_id: input.voiceId },
      },
      {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      },
    );
    const status = parseVoiceStatus(response.data);
    if (status === "OK") return status;
    if (status === "UNDEPLOYED" || status === "FAILED") {
      throw new Error(`音色 ${input.voiceId} 状态 ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`音色 ${input.voiceId} 等待就绪超时`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const model =
    process.env.VIDEO_TTS_MODEL_CLONED?.trim() || "cosyvoice-v3.5-flash";
  const dir =
    process.env.VIDEO_VOICE_SAMPLE_DIR?.trim() || "local-assets/voices";
  const apiBase = baseUrl(env("BAILIAN_WORKSPACE_ID"));
  const apiKey = env("BAILIAN_API_KEY");

  const missing: Role[] = [];
  const samples = new Map<Role, string>();
  for (const role of ROLES) {
    const path = await findSample(dir, role);
    if (path) samples.set(role, path);
    else missing.push(role);
  }
  if (missing.length > 0) {
    console.error(
      `缺少样本：${missing.join(", ")}。请按 ${dir}/{elly,polly,narrator}.wav|mp3|m4a 放置。`,
    );
    process.exit(2);
  }

  const prisma = new PrismaClient();
  try {
    for (const role of ROLES) {
      const voiceId = await createVoice({
        apiBase,
        apiKey,
        model,
        role,
        audioPath: samples.get(role)!,
        dryRun,
      });
      if (dryRun) continue;
      await waitForReady({ apiBase, apiKey, voiceId });
      await prisma.adventureVideoVoice.upsert({
        where: { role },
        create: { role, model, voiceId, status: "ready" },
        update: { model, voiceId, status: "ready" },
      });
      console.log(`${role} → ${voiceId}`);
    }
    console.log(
      dryRun
        ? "dry-run 完成；确认样本后去掉 --dry-run 再跑一次。"
        : "三条音色已写入 adventure_video_voices；现在可把 VIDEO_TTS_MODE 切到 cloned。",
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main();
