/**
 * 主链路联调脚本：模拟百度 RTC 以 OpenAI 兼容协议连续推 10 轮对话
 * （覆盖 edge cases），POST /v1/chat/completions → LLM 适配层。
 *
 * 与 mock-vendor-dialog.js（老 WS 备选链路）的差异：
 * - 走 HTTP + SSE，而非 socket.io
 * - 每轮把上一轮 assistant 回复拼进 messages，模拟百度携带完整对话历史
 *   （同时验证适配层无状态透传假设）
 * - 记录每轮首 chunk 延迟，对齐立项书甲方处理段 ≤0.8s 目标
 *
 * 用法：
 *   LLM_ADAPTER_API_KEY=xxx APP_PORT=4571 npm run start:dev
 *   ADAPTER_KEY=xxx node scripts/mock-baidu-dialog.js
 *   ADAPTER_KEY=xxx DEVICE_ID=dev-baidu-001 node scripts/mock-baidu-dialog.js
 *
 * DEVICE_ID（2A 起）：设置后按机芯厂约定以 user 字段携带设备标识
 * （真实环境 = 设备 MAC），触发适配层的建档/落库/记忆链路；
 * 不设置则走匿名链路（无落库无记忆），用于纯管道验证。
 */
const BASE_URL = process.env.API_BASE_URL || "http://localhost:4571";
const ADAPTER_KEY =
  process.env.ADAPTER_KEY || process.env.LLM_ADAPTER_API_KEY || "";
// 设备标识：机芯厂约定真实环境为设备 MAC（如 AA:BB:CC:DD:EE:FF）
const DEVICE_ID = process.env.DEVICE_ID || "";

// 与 mock-vendor-dialog.js 相同的 10 轮 edge case：
// 标准中文 / 纯英文 / 中英混杂 / ASR 混乱无意义 / 拼音乱识别 /
// 离题 / 重复第 1 轮（测回复多样性）/ 极短 / 长啰嗦句 / 英文离题
const TURNS = [
  { tag: "标准中文", text: "我们今天学了打招呼，你会吗" },
  { tag: "纯英文", text: "Hello, how are you?" },
  { tag: "中英混杂", text: "我喜欢 play basketball" },
  { tag: "ASR混乱无意义", text: "呃呃那个嗯……阿巴阿巴" },
  { tag: "拼音乱识别", text: "shang hai tian qi hen hao a" },
  { tag: "离题", text: "我想吃冰淇淋和看奥特曼" },
  { tag: "重复第1轮", text: "我们今天学了打招呼，你会吗" },
  { tag: "极短", text: "hi" },
  {
    tag: "长啰嗦句",
    text: "嗯我想问你一个问题就是为什么天空是蓝色的然后云是白色的呢",
  },
  { tag: "英文离题", text: "I want a puppy! Can I have a puppy?" },
];

// 模拟百度 llm_sys 注入的兜底人设
const SYSTEM_MESSAGE = {
  role: "system",
  content:
    "你是Deda，一只陪6到12岁孩子练习英语口语的毛绒玩具。只用简单友好的英语交流，根据孩子的水平调整用词。保持回复简短（1-3句话），多鼓励孩子开口。",
};

if (!ADAPTER_KEY) {
  console.error("ERROR: 缺少 ADAPTER_KEY（或 LLM_ADAPTER_API_KEY）");
  process.exit(1);
}

/** 解析 SSE 流，返回 { text, firstChunkMs } */
async function postStream(messages) {
  const t0 = Date.now();
  let firstChunkMs = null;
  let text = "";

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADAPTER_KEY}`,
    },
    body: JSON.stringify({
      model: "deda-english-tutor",
      stream: true,
      // 有设备标识才带 user 字段（机芯厂约定 = 设备 MAC）
      ...(DEVICE_ID ? { user: DEVICE_ID } : {}),
      thinking: { type: "disabled" },
      messages,
    }),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      if (!frame.startsWith("data: ")) continue;
      const data = frame.slice(6);
      if (data === "[DONE]") continue;
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
        text += delta;
      }
    }
  }
  return { text, firstChunkMs, totalMs: Date.now() - t0 };
}

(async () => {
  console.log(`POST ${BASE_URL}/v1/chat/completions (10 turns)`);
  console.log(
    DEVICE_ID
      ? `device: ${DEVICE_ID}（建档/落库/记忆链路）\n`
      : "匿名模式（无设备标识，纯管道验证）\n",
  );
  // 模拟百度行为：携带完整对话历史（system + 全部历史轮次）
  const messages = [SYSTEM_MESSAGE];

  for (let i = 0; i < TURNS.length; i++) {
    const turn = TURNS[i];
    messages.push({ role: "user", content: turn.text });
    try {
      const r = await postStream(messages);
      messages.push({ role: "assistant", content: r.text });
      console.log(
        `--- turn ${i + 1} [${turn.tag}] 首chunk=${r.firstChunkMs}ms 总=${r.totalMs}ms`,
      );
      console.log(`user: ${turn.text}`);
      console.log(`bot:  ${JSON.stringify(r.text)}\n`);
    } catch (err) {
      console.error(`turn ${i + 1} [${turn.tag}] FAILED: ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
})();
