/**
 * 手工联调脚本：模拟机芯厂云通过入站 WS 推一条用户 ASR 文字，
 * 走完整链路（小模型 filler + 大模型 answer），等待 vendor:text:out 应答。
 * 用法：先启动服务（npm run start），再 node scripts/mock-vendor-text-in.js
 */
const { io } = require("socket.io-client");

const DEVICE_ID = "d6652314-2a68-4893-9014-322bc938856a";
const ASR_TEXT = "我喜欢上海的天气";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

const socket = io(`${BASE_URL}/vendor`, {
  transports: ["websocket"],
  forceNew: true,
});

const timer = setTimeout(() => {
  console.error("TIMEOUT: 60s 内未收到 vendor:text:out");
  socket.disconnect();
  process.exit(1);
}, 60000);

socket.on("connect", () => {
  console.log(`connected to ${BASE_URL}/vendor`);
  const t0 = Date.now();
  console.log(`emit vendor:text:in deviceId=${DEVICE_ID} asrText="${ASR_TEXT}"`);
  socket.emit("vendor:text:in", { deviceId: DEVICE_ID, asrText: ASR_TEXT });

  socket.once("vendor:text:out", (data) => {
    clearTimeout(timer);
    console.log(`received vendor:text:out in ${Date.now() - t0}ms`);
    console.log("responseText:", JSON.stringify(data.responseText));
    console.log("context:", JSON.stringify(data.context));
    socket.disconnect();
    process.exit(0);
  });
});

socket.on("connect_error", (err) => {
  clearTimeout(timer);
  console.error("connect_error:", err.message);
  process.exit(1);
});
