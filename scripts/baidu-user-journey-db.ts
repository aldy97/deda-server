/**
 * 百度 RTC 新链路（POST /v1/chat/completions）全链路验收的数据库助手。
 * 由 scripts/test-baidu-user-journey.sh 调用，不独立使用。
 *
 * 与 local-user-journey-db.ts 的差异：
 * - 面向新链路自动建档语义：测试设备用 MAC 地址，可由适配层自动创建；
 * - 新增动作：assert-sleep-config / assert-safety-turn / count-all-messages /
 *   count-all-devices / device-exists / device-message-count；
 * - 移除家长端相关动作（登录/报告/学习统计与链路无关，老链路已覆盖）；
 * - 已知降级：新链路无推送通道，10s 沉默超时推进不适用（脚本标 N/A）。
 *
 * 通过 TEST_DEVICE_MAC 指定主测试设备（默认 AA:BB:CC:DD:EE:01）。
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TEST_DEVICE_MAC = process.env.TEST_DEVICE_MAC || "AA:BB:CC:DD:EE:01";
const HEADER_TEST_MAC = "AA:BB:CC:DD:EE:99";
const HEADER_SHADOW_MAC = "AA:BB:CC:DD:EE:98";

const EPISODE_KEY = {
  characterKey: "elly",
  season: 1,
  episodeNumber: 2,
};

function dateKey(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function offsetDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

/** 与 LlmAdapterService.normalizeMac 同口径：AA:BB:.. / AA-BB-.. → aabb.. */
function normalizeMac(value: string): string {
  if (
    !/^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{12}$/.test(value)
  ) {
    return value;
  }
  return value.replace(/[:-]/g, "").toLowerCase();
}

function deviceCandidates(raw: string): string[] {
  return Array.from(new Set([raw, normalizeMac(raw)]));
}

async function findDevice(raw: string) {
  const candidates = deviceCandidates(raw);
  return prisma.device.findFirst({
    where: {
      OR: [
        { deviceId: { in: candidates } },
        { macAddress: { in: candidates } },
      ],
    },
    select: { id: true, deviceId: true, characterKey: true },
  });
}

async function getDevice() {
  const device = await findDevice(TEST_DEVICE_MAC);
  if (!device) throw new Error(`Test device not found: ${TEST_DEVICE_MAC}`);
  return device;
}

async function getEpisode(episodeNumber: number) {
  const episode = await prisma.adventureEpisode.findUnique({
    where: {
      characterKey_season_episodeNumber: {
        ...EPISODE_KEY,
        episodeNumber,
      },
    },
    include: { segments: { orderBy: { order: "asc" } } },
  });
  if (!episode) throw new Error(`Elly episode ${episodeNumber} not found`);
  return episode;
}

async function prepare() {
  // 第 1 集由 scripts/seed-adventure.ts 负责，内容不在此复制
  const episode1 = await prisma.adventureEpisode.findUnique({
    where: {
      characterKey_season_episodeNumber: {
        characterKey: "elly",
        season: 1,
        episodeNumber: 1,
      },
    },
  });
  if (!episode1) {
    throw new Error(
      "Elly episode 1 not found; run: npx ts-node scripts/seed-adventure.ts",
    );
  }

  // 测试设备：存在则复用（新链路也会按 MAC 自动建档），不存在则预建档
  let device = await findDevice(TEST_DEVICE_MAC);
  if (!device) {
    device = await prisma.device.create({
      data: {
        deviceId: TEST_DEVICE_MAC,
        macAddress: normalizeMac(TEST_DEVICE_MAC),
        characterKey: "elly",
      },
      select: { id: true, deviceId: true, characterKey: true },
    });
  }

  // 旅程断言基于 free_chat 顶层模式快照；重置为自由对话默认配置保证可复现
  await prisma.deviceConfig.updateMany({
    where: { deviceId: device.id, isActive: true },
    data: { isActive: false },
  });
  await prisma.deviceConfig.create({
    data: {
      deviceId: device.id,
      mode: "free_chat",
      conversationModeKey: "free_chat_casual",
      language: "bilingual",
      speechRate: "normal",
      isActive: true,
    },
  });
  await prisma.conversationSession.deleteMany({
    where: { deviceId: device.id },
  });

  // 完结集数的成对语义：DailyRecord（每日门禁判 completedDate）+
  // Progress（startToday 判已完结集数），缺一则状态机行为失真。
  // 除测试用的第 2 集外，把其余已发布集全部标记为两天前完成——
  // 全新测试设备否则会在「目录耗尽」用例里继续开后面的集。
  // 第 1 集若已有完成记录则保留原完成日（门禁用例依赖改这个值）。
  let episode1OriginalDate = "";
  const catalogue = await prisma.adventureEpisode.findMany({
    where: { characterKey: "elly", season: 1, published: true },
    orderBy: { episodeNumber: "asc" },
  });
  for (const [index, episode] of catalogue.entries()) {
    if (episode.episodeNumber === EPISODE_KEY.episodeNumber) continue;
    // assignedDate 有 (deviceId, assignedDate) 唯一约束：各集错开分配日
    const pastDate = offsetDate(-(2 + index));
    const daily = await prisma.adventureDailyRecord.findFirst({
      where: { deviceId: device.id, episodeId: episode.id },
      orderBy: { assignedAt: "desc" },
    });
    if (episode.episodeNumber === 1) {
      if (daily && !daily.completedDate) {
        throw new Error("Episode 1 must already be completed for this journey");
      }
      episode1OriginalDate = daily?.completedDate ?? pastDate;
    }
    if (!daily) {
      await prisma.adventureDailyRecord.create({
        data: {
          deviceId: device.id,
          episodeId: episode.id,
          assignedDate: pastDate,
          assignedAt: new Date(`${pastDate}T02:00:00.000Z`),
          status: "completed",
          completedDate: pastDate,
          completedAt: new Date(`${pastDate}T04:00:00.000Z`),
        },
      });
    }
    const progress = await prisma.adventureProgress.findUnique({
      where: {
        deviceId_episodeId: { deviceId: device.id, episodeId: episode.id },
      },
    });
    if (!progress) {
      const segmentCount = await prisma.adventureSegment.count({
        where: { episodeId: episode.id },
      });
      await prisma.adventureProgress.create({
        data: {
          deviceId: device.id,
          episodeId: episode.id,
          status: "completed",
          nextSegmentOrder: segmentCount,
          completedAt:
            daily?.completedAt ?? new Date(`${pastDate}T04:00:00.000Z`),
        },
      });
    }
  }

  // 第 2 集测试剧情：与 local-user-journey-db.ts 保持一致
  let episode2 = await prisma.adventureEpisode.findUnique({
    where: { characterKey_season_episodeNumber: EPISODE_KEY },
    include: { segments: true },
  });
  if (episode2 && episode2.title !== "Elly 与会发光的小纸船") {
    throw new Error(
      `Refusing to overwrite existing episode 2: ${episode2.title}`,
    );
  }
  if (!episode2) {
    episode2 = await prisma.adventureEpisode.create({
      data: {
        ...EPISODE_KEY,
        title: "Elly 与会发光的小纸船",
        recap:
          "小象 Elly 温暖又好奇，想把发光的小纸船送过河，却总想独自完成，不好意思请朋友帮忙。",
        published: true,
        segments: {
          create: [
            {
              order: 0,
              kind: "narration",
              text: "傍晚，Elly 在河边发现一只会发光的小纸船。它想把纸船送到对岸，给怕黑的小萤火虫照路。",
            },
            {
              order: 1,
              kind: "interaction",
              interactionType: "two_choice",
              text: "你想让 Elly 沿着闪闪发光的小河走，还是穿过开满鲜花的小路？",
              options: {
                choices: [
                  {
                    key: "river",
                    text: "小河",
                    reply: "好呀，我们沿着小河走，让纸船的光映在水面上！",
                  },
                  {
                    key: "flowers",
                    text: "鲜花",
                    reply: "好呀，我们穿过鲜花小路，让花香陪着纸船出发！",
                  },
                ],
              },
              fallbackText: "没关系，我们先沿着小河慢慢走。",
              exitText: "好呀，我们先休息，等你准备好再陪 Elly 出发。",
            },
            {
              order: 2,
              kind: "narration",
              text: "一阵风吹来，纸船卡在了浅滩的芦苇里。Elly 用力拉了拉，却担心把纸船拉破，小松鼠就在不远处。",
            },
            {
              order: 3,
              kind: "interaction",
              interactionType: "open_question",
              text: "Elly 有点不好意思求助。你觉得它可以对小松鼠说什么呢？",
              fallbackText: "开口求助有点难，我们陪 Elly 一起鼓起勇气。",
              exitText: "好呀，我们先陪 Elly 休息一下。",
            },
            {
              order: 4,
              kind: "narration",
              text: "Elly 看着小松鼠，轻轻吸了一口气。它决定试着说出自己的需要。",
            },
            {
              order: 5,
              kind: "interaction",
              interactionType: "repeat_after_me",
              text: "跟 Elly 一起说：请帮我一下，好吗？",
              options: { praise: "说得真好！勇敢求助，也是在照顾朋友。" },
              fallbackText: "这次 Elly 替你说：请帮我一下，好吗？",
              exitText: "好呀，我们下次再一起练习。",
            },
            {
              order: 6,
              kind: "narration",
              text: "小松鼠连忙点头。它们一个扶住芦苇，一个托起纸船，终于让纸船重新漂了起来。",
            },
            {
              order: 7,
              kind: "interaction",
              interactionType: "open_question",
              text: "小萤火虫收到纸船后，你觉得它会对 Elly 和小松鼠说什么？",
              fallbackText: "小萤火虫轻轻说：谢谢你们，我不再害怕黑夜啦。",
              exitText: "好呀，我们先在这里休息，下次再陪纸船到对岸。",
            },
            {
              order: 8,
              kind: "narration",
              text: "纸船快到对岸了，前方有一块小石头挡住水道。Elly 这次没有再独自硬撑。",
            },
            {
              order: 9,
              kind: "interaction",
              interactionType: "two_choice",
              text: "你想让 Elly 请小松鼠一起推开石头，还是请纸船顺着旁边的小水流绕过去？",
              options: {
                choices: [
                  {
                    key: "push",
                    text: "推开石头",
                    reply: "好呀，朋友一起想办法，Elly 觉得很安心！",
                  },
                  {
                    key: "around",
                    text: "绕过去",
                    reply: "好呀，我们陪着纸船顺着小水流绕过去！",
                  },
                ],
              },
              fallbackText: "没关系，我们请纸船顺着旁边的小水流绕过去。",
              exitText: "好呀，我们先休息，下次再陪纸船到对岸。",
            },
            {
              order: 10,
              kind: "narration",
              text: "小纸船终于到达对岸，小萤火虫围着亮光开心地飞舞。Elly 明白啦，请朋友帮忙不是添麻烦，而是一起完成美好的事情。",
            },
          ],
        },
      },
      include: { segments: true },
    });
  }
  const interactionCount = episode2.segments.filter(
    (segment) => segment.kind === "interaction",
  ).length;
  if (episode2.segments.length !== 11 || interactionCount !== 5) {
    throw new Error(
      "Test episode 2 must contain 11 segments and 5 interactions",
    );
  }
  const existingProgress = await prisma.adventureProgress.findUnique({
    where: {
      deviceId_episodeId: { deviceId: device.id, episodeId: episode2.id },
    },
  });
  if (existingProgress) {
    throw new Error(
      `Test episode 2 already has progress (${existingProgress.status}); run with RESET_BAIDU_JOURNEY=1 to reset`,
    );
  }
  console.log(
    JSON.stringify({
      deviceId: device.deviceId,
      episode1OriginalDate,
      episode2Id: episode2.id,
      interactionCount,
    }),
  );
}

async function setEpisode1Date(value: string) {
  const device = await getDevice();
  const episode1 = await getEpisode(1);
  const daily = await prisma.adventureDailyRecord.findFirst({
    where: { deviceId: device.id, episodeId: episode1.id },
    orderBy: { assignedAt: "desc" },
  });
  if (!daily) throw new Error("Episode 1 daily record not found");
  await prisma.adventureDailyRecord.update({
    where: { id: daily.id },
    data: {
      status: "completed",
      completedDate: value,
      completedAt: new Date(`${value}T04:00:00.000Z`),
    },
  });
}

async function assertNoProgress(episodeNumber: number) {
  const device = await getDevice();
  const episode = await getEpisode(episodeNumber);
  const progress = await prisma.adventureProgress.findUnique({
    where: {
      deviceId_episodeId: { deviceId: device.id, episodeId: episode.id },
    },
  });
  if (progress) throw new Error(`Unexpected episode ${episodeNumber} progress`);
}

async function getCurrent(episodeNumber: number) {
  const device = await getDevice();
  const episode = await getEpisode(episodeNumber);
  const daily = await prisma.adventureDailyRecord.findFirst({
    where: {
      deviceId: device.id,
      episodeId: episode.id,
      status: "in_progress",
    },
    orderBy: { assignedAt: "desc" },
  });
  if (!daily)
    throw new Error(`No in-progress daily for episode ${episodeNumber}`);
  const progress = await prisma.adventureProgress.findUnique({
    where: {
      deviceId_episodeId: { deviceId: device.id, episodeId: episode.id },
    },
  });
  if (!progress) throw new Error(`No progress for episode ${episodeNumber}`);
  return { daily, progress };
}

async function assertCurrent(status?: string, nextSegmentOrder?: number) {
  const { daily, progress } = await getCurrent(2);
  if (daily.episodeId !== (await getEpisode(2)).id) {
    throw new Error("Current adventure is not test episode 2");
  }
  if (status && progress.status !== status) {
    throw new Error(`Expected progress ${status}, got ${progress.status}`);
  }
  if (
    nextSegmentOrder !== undefined &&
    progress.nextSegmentOrder !== nextSegmentOrder
  ) {
    throw new Error(
      `Expected nextSegmentOrder ${nextSegmentOrder}, got ${progress.nextSegmentOrder}`,
    );
  }
}

async function assertMessage(content: string, mode: string) {
  const device = await getDevice();
  const user = await prisma.message.findFirst({
    where: { deviceId: device.id, role: "user", content },
    orderBy: { createdAt: "desc" },
  });
  if (!user) throw new Error(`User message not found: ${content}`);
  if (user.mode !== mode) {
    throw new Error(`Expected mode ${mode}, got ${user.mode} for ${content}`);
  }
  const assistant = await prisma.message.findFirst({
    where: { deviceId: device.id, turnId: user.turnId, role: "assistant" },
  });
  if (!assistant || !assistant.content) {
    throw new Error(`Assistant message missing for turn ${user.turnId}`);
  }
  if (assistant.status !== "completed" || assistant.mode !== mode) {
    throw new Error(
      `Invalid assistant state for ${user.turnId}: status=${assistant.status}, mode=${assistant.mode}`,
    );
  }
  const payload = assistant.rawPayload as {
    filler?: unknown;
    answer?: unknown;
    sleepConfig?: unknown;
    safetyCategory?: unknown;
  } | null;
  if (typeof payload?.answer !== "string" || payload.answer.length === 0) {
    throw new Error(`Missing structured LLM answer for turn ${user.turnId}`);
  }
  // 确定性短链路回复（安全拦截 / 哄睡配置确认）不调大模型，无 filler，豁免
  const isCannedReply =
    payload?.safetyCategory !== undefined || payload?.sleepConfig !== undefined;
  if (
    mode !== "adventure_story" &&
    typeof payload.filler !== "string" &&
    !isCannedReply
  ) {
    throw new Error(`Missing streamed filler for turn ${user.turnId}`);
  }
  const expectedContent = [payload.filler, payload.answer]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n");
  if (assistant.content !== expectedContent) {
    throw new Error(`Filler/answer boundary mismatch for turn ${user.turnId}`);
  }
  console.log(user.turnId);
}

/**
 * 安全拦截落库断言（新链路新增覆盖，老安全脚本仅匿名链路）：
 * user/assistant 成对落库，assistant rawPayload 标注拦截层与类别。
 */
async function assertSafetyTurn(
  content: string,
  layer: string,
  category: string,
) {
  const device = await getDevice();
  const user = await prisma.message.findFirst({
    where: { deviceId: device.id, role: "user", content },
    orderBy: { createdAt: "desc" },
  });
  if (!user) throw new Error(`Safety user message not found: ${content}`);
  if (user.mode !== "free_chat") {
    throw new Error(`Safety turn expected mode free_chat, got ${user.mode}`);
  }
  const assistant = await prisma.message.findFirst({
    where: { deviceId: device.id, turnId: user.turnId, role: "assistant" },
  });
  const payload = assistant?.rawPayload as {
    safetyLayer?: unknown;
    safetyCategory?: unknown;
  } | null;
  if (
    !assistant ||
    assistant.status !== "completed" ||
    payload?.safetyLayer !== layer ||
    payload?.safetyCategory !== category
  ) {
    throw new Error(
      `Safety turn mismatch for [${content}]: expected ${layer}/${category}, got ${payload?.safetyLayer}/${payload?.safetyCategory}`,
    );
  }
}

/** 哄睡配置落库断言（替代老链路的家长端 API 断言，直接验库） */
async function assertSleepConfig(field: string, value: string) {
  const device = await getDevice();
  const config = await prisma.sleepConfig.findUnique({
    where: { deviceId: device.id },
  });
  if (!config) throw new Error("SleepConfig not found for test device");
  if (field === "contentType" && config.contentType !== value) {
    throw new Error(`Expected contentType=${value}, got ${config.contentType}`);
  }
  if (field === "sleepTime" && config.sleepTime !== value) {
    throw new Error(`Expected sleepTime=${value}, got ${config.sleepTime}`);
  }
  if (field === "durationMinutes") {
    if (
      config.durationMode !== "custom" ||
      config.durationMinutes !== Number(value)
    ) {
      throw new Error(
        `Expected durationMode=custom durationMinutes=${value}, got ${config.durationMode}/${config.durationMinutes}`,
      );
    }
  }
}

async function moveCurrentDailyToYesterday() {
  const { daily } = await getCurrent(2);
  const yesterday = offsetDate(-1);
  await prisma.adventureDailyRecord.update({
    where: { id: daily.id },
    data: {
      assignedDate: yesterday,
      assignedAt: new Date(`${yesterday}T02:00:00.000Z`),
    },
  });
}

async function assertCompleted() {
  const device = await getDevice();
  const episode = await getEpisode(2);
  const progress = await prisma.adventureProgress.findUnique({
    where: {
      deviceId_episodeId: { deviceId: device.id, episodeId: episode.id },
    },
  });
  const daily = await prisma.adventureDailyRecord.findFirst({
    where: { deviceId: device.id, episodeId: episode.id, status: "completed" },
    orderBy: { assignedAt: "desc" },
  });
  if (
    progress?.status !== "completed" ||
    progress.nextSegmentOrder !== 11 ||
    daily?.completedDate !== dateKey()
  ) {
    throw new Error("Episode 2 did not complete today at segment 11");
  }
}

async function setCurrentCompletedDate(value: string) {
  const device = await getDevice();
  const episode = await getEpisode(2);
  const completedAt = new Date(`${value}T04:00:00.000Z`);
  const daily = await prisma.adventureDailyRecord.findFirstOrThrow({
    where: { deviceId: device.id, episodeId: episode.id, status: "completed" },
    orderBy: { assignedAt: "desc" },
  });
  await prisma.$transaction([
    prisma.adventureDailyRecord.update({
      where: { id: daily.id },
      data: { completedDate: value, completedAt },
    }),
    prisma.adventureProgress.update({
      where: {
        deviceId_episodeId: { deviceId: device.id, episodeId: episode.id },
      },
      data: { completedAt },
    }),
  ]);
}

async function assertAdventureExhausted() {
  const device = await getDevice();
  const [episodes, progresses, inProgress] = await Promise.all([
    prisma.adventureEpisode.findMany({
      where: { characterKey: "elly", season: 1, published: true },
      select: { id: true },
    }),
    prisma.adventureProgress.findMany({
      where: { deviceId: device.id },
      select: { episodeId: true, status: true },
    }),
    prisma.adventureDailyRecord.count({
      where: { deviceId: device.id, status: "in_progress" },
    }),
  ]);
  const completed = new Set(
    progresses
      .filter((item) => item.status === "completed")
      .map((item) => item.episodeId),
  );
  if (
    inProgress !== 0 ||
    episodes.some((episode) => !completed.has(episode.id))
  ) {
    throw new Error(
      "Exhausted catalogue has an unfinished or newly replayed episode",
    );
  }
}

async function assertEntryBlocked() {
  const device = await getDevice();
  const count = await prisma.adventureEvent.count({
    where: { deviceId: device.id, eventType: "entry_blocked_completed" },
  });
  if (count < 1) throw new Error("Missing entry_blocked_completed event");
}

async function waitForMemory(value: string) {
  const device = await getDevice();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const active = await prisma.childMemory.findFirst({
      where: {
        deviceId: device.id,
        key: "favorite_color",
        status: "active",
      },
      orderBy: { version: "desc" },
    });
    if (active?.valueText?.includes(value)) {
      if (value === "蓝色") {
        const previous = await prisma.childMemory.findFirst({
          where: {
            deviceId: device.id,
            key: "favorite_color",
            status: "superseded",
            valueText: { contains: "红色" },
          },
        });
        if (!previous)
          throw new Error("Red memory was not retained as superseded");
      }
      console.log(JSON.stringify(active));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for favorite_color=${value}`);
}

/** 清掉本脚本拥有的全部测试数据（三个测试 MAC 设备整行删除，级联清理） */
async function resetBaiduJourney() {
  for (const raw of [TEST_DEVICE_MAC, HEADER_TEST_MAC, HEADER_SHADOW_MAC]) {
    const device = await findDevice(raw);
    if (!device) continue;
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { deviceId: device.id } }),
      prisma.childMemory.deleteMany({ where: { deviceId: device.id } }),
      prisma.adventureEvent.deleteMany({ where: { deviceId: device.id } }),
      prisma.adventureProgress.deleteMany({ where: { deviceId: device.id } }),
      prisma.adventureDailyRecord.deleteMany({
        where: { deviceId: device.id },
      }),
      prisma.conversationSession.deleteMany({ where: { deviceId: device.id } }),
      prisma.sleepConfig.deleteMany({ where: { deviceId: device.id } }),
      prisma.deviceConfig.deleteMany({ where: { deviceId: device.id } }),
      prisma.device.delete({ where: { id: device.id } }),
    ]);
  }
}

async function summary() {
  const device = await getDevice();
  const [
    messages,
    memories,
    dailyRecords,
    progresses,
    events,
    sleepConfig,
    failedReplies,
  ] = await Promise.all([
    prisma.message.groupBy({
      by: ["mode"],
      where: { deviceId: device.id, role: "user" },
      _count: { _all: true },
    }),
    prisma.childMemory.findMany({
      where: { deviceId: device.id, key: "favorite_color" },
      orderBy: { version: "asc" },
      select: {
        valueText: true,
        status: true,
        version: true,
        changeType: true,
      },
    }),
    prisma.adventureDailyRecord.findMany({
      where: { deviceId: device.id },
      orderBy: { assignedAt: "asc" },
      select: {
        episode: { select: { episodeNumber: true, title: true } },
        assignedDate: true,
        completedDate: true,
        status: true,
      },
    }),
    prisma.adventureProgress.findMany({
      where: { deviceId: device.id },
      orderBy: { createdAt: "asc" },
      select: {
        episode: { select: { episodeNumber: true } },
        status: true,
        nextSegmentOrder: true,
        stars: true,
        offTopicCount: true,
        completedAt: true,
      },
    }),
    prisma.adventureEvent.groupBy({
      by: ["eventType"],
      where: { deviceId: device.id },
      _count: { _all: true },
    }),
    prisma.sleepConfig.findUnique({
      where: { deviceId: device.id },
      select: {
        contentType: true,
        durationMode: true,
        durationMinutes: true,
        sleepTime: true,
      },
    }),
    prisma.message.count({
      where: { deviceId: device.id, role: "assistant", status: "failed" },
    }),
  ]);
  console.log(
    JSON.stringify(
      {
        messages,
        memories,
        dailyRecords,
        progresses,
        events,
        sleepConfig,
        failedReplies,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  switch (action) {
    case "prepare":
      await prepare();
      break;
    case "today":
      console.log(dateKey());
      break;
    case "yesterday":
      console.log(offsetDate(-1));
      break;
    case "date-offset":
      console.log(offsetDate(Number(args[0])));
      break;
    case "set-episode1-date":
      await setEpisode1Date(args[0]);
      break;
    case "assert-no-progress":
      await assertNoProgress(Number(args[0]));
      break;
    case "assert-current":
      await assertCurrent(
        args[0],
        args[1] === undefined ? undefined : Number(args[1]),
      );
      break;
    case "assert-message":
      await assertMessage(args[0], args[1]);
      break;
    case "assert-safety-turn":
      await assertSafetyTurn(args[0], args[1], args[2]);
      break;
    case "assert-sleep-config":
      await assertSleepConfig(args[0], args[1]);
      break;
    case "move-current-daily-yesterday":
      await moveCurrentDailyToYesterday();
      break;
    case "assert-completed":
      await assertCompleted();
      break;
    case "set-current-completed-date":
      await setCurrentCompletedDate(args[0]);
      break;
    case "assert-adventure-exhausted":
      await assertAdventureExhausted();
      break;
    case "assert-entry-blocked":
      await assertEntryBlocked();
      break;
    case "wait-memory":
      await waitForMemory(args[0]);
      break;
    case "count-all-messages":
      console.log(await prisma.message.count());
      break;
    case "count-all-devices":
      console.log(await prisma.device.count());
      break;
    case "device-exists": {
      const found = await findDevice(args[0]);
      console.log(found ? "yes" : "no");
      break;
    }
    case "device-message-count": {
      const found = await findDevice(args[0]);
      if (!found) {
        console.log(0);
      } else {
        console.log(
          await prisma.message.count({ where: { deviceId: found.id } }),
        );
      }
      break;
    }
    case "reset-baidu-journey":
      await resetBaiduJourney();
      break;
    case "summary":
      await summary();
      break;
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
