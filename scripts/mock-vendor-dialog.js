/**
 * 手工联调脚本：模拟机芯厂云连续推 10 轮 ASR 文字（覆盖 edge cases），
 * 真实调用小模型 filler + 大模型 answer，并真实落库。
 * 用法：先启动服务（APP_PORT=3100 npm run start），再 node scripts/mock-vendor-dialog.js
 */
const { io } = require("socket.io-client");

const DEVICE_ID = "d6652314-2a68-4893-9014-322bc938856a";
const BASE_URL = process.env.BASE_URL || "http://localhost:3100";

// 10 轮 edge case：标准中文 / 纯英文 / 中英混杂 / ASR 混乱无意义 / 拼音乱识别 /
// 离题 / 重复第 1 轮（测 filler 多样性禁令）/ 极短 / 长啰嗦句 / 英文离题
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

const socket = io(`${BASE_URL}/vendor`, {
  transports: ["websocket"],
  forceNew: true,
});

const results = [];

function sendTurn(index) {
  return new Promise((resolve, reject) => {
    const turn = TURNS[index];
    const timer = setTimeout(
      () => reject(new Error(`turn ${index + 1} timeout`)),
      60000,
    );
    const t0 = Date.now();
    socket.once("vendor:text:out", (data) => {
      clearTimeout(timer);
      resolve({ ...turn, latencyMs: Date.now() - t0, data });
    });
    socket.emit("vendor:text:in", { deviceId: DEVICE_ID, asrText: turn.text });
  });
}

socket.on("connect", async () => {
  console.log(`connected to ${BASE_URL}/vendor, device=${DEVICE_ID}\n`);
  try {
    for (let i = 0; i < TURNS.length; i++) {
      const r = await sendTurn(i);
      results.push(r);
      console.log(`--- turn ${i + 1} [${r.tag}] (${r.latencyMs}ms)`);
      console.log(`user: ${r.text}`);
      console.log(`bot:  ${JSON.stringify(r.data.responseText)}\n`);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    socket.disconnect();
  }
});

socket.on("connect_error", (err) => {
  console.error("connect_error:", err.message);
  process.exit(1);
});
