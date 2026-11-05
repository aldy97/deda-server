#!/usr/bin/env bash
# 模拟百度 RTC 第三方 LLM 回调（OpenAI 兼容协议）冒烟脚本。
# 主链路：设备 ⇄ 百度 RTC → POST /v1/chat/completions → 本服务 LLM 适配层。
#
# 用法：
#   LLM_ADAPTER_API_KEY=xxx APP_PORT=4571 npm run start:dev   # 先启动本地后端
#   ./scripts/simulate-baidu-llm.sh                            # 默认流式
#   STREAM=false ./scripts/simulate-baidu-llm.sh               # 非流式
#   WITH_EXTENSIONS=true ./scripts/simulate-baidu-llm.sh       # 模拟 llm_eb 注入扩展字段
#
# 环境变量：
#   API_BASE_URL  默认 http://127.0.0.1:4571
#   ADAPTER_KEY   默认读环境 LLM_ADAPTER_API_KEY（需与服务端一致）
#   TEXT          默认 "Hello! What is your name?"
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:4571}"
ADAPTER_KEY="${ADAPTER_KEY:-${LLM_ADAPTER_API_KEY:-}}"
TEXT="${TEXT:-Hello! What is your name?}"
STREAM="${STREAM:-true}"
WITH_EXTENSIONS="${WITH_EXTENSIONS:-false}"

if [[ -z "$ADAPTER_KEY" ]]; then
  echo "ERROR: 缺少 ADAPTER_KEY（或 .env 里的 LLM_ADAPTER_API_KEY）"
  exit 1
fi

# 模拟百度 llm_sys 注入的兜底人设 system 消息
PAYLOAD=$(jq -n --arg text "$TEXT" --argjson stream "$STREAM" '{
  model: "deda-english-tutor",
  stream: $stream,
  messages: [
    {role: "system", content: "你是Deda，一只陪6到12岁孩子练习英语口语的毛绒玩具。"},
    {role: "user", content: $text}
  ]
}')

# 模拟百度 llm_eb 注入的 body 扩展字段（适配层必须容忍未知字段）
if [[ "$WITH_EXTENSIONS" == "true" ]]; then
  PAYLOAD=$(echo "$PAYLOAD" | jq '. + {thinking: {type: "disabled"}, user: "deda-toy"}')
fi

echo "POST $API_BASE_URL/v1/chat/completions (stream=$STREAM, extensions=$WITH_EXTENSIONS)"
echo ""

# macOS BSD date 不支持 %3N，用 perl 取毫秒
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }

T0=$(now_ms)
FIRST_CHUNK_MS=""

if [[ "$STREAM" == "true" ]]; then
  # 流式：逐行打印 SSE，记录首 chunk 延迟（对齐立项书甲方处理段 ≤0.8s 目标）
  while IFS= read -r line; do
    # 只统计首个含 content 的帧（跳过立即写出的 role 帧）
    if [[ -z "$FIRST_CHUNK_MS" && "$line" == data:*\"content\"* ]]; then
      FIRST_CHUNK_MS=$(( $(now_ms) - T0 ))
    fi
    echo "$line"
  done < <(curl -s -N --max-time 60 -X POST "$API_BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADAPTER_KEY" \
    -d "$PAYLOAD")
  echo ""
  if [[ -n "$FIRST_CHUNK_MS" ]]; then
    echo "首 chunk 延迟: ${FIRST_CHUNK_MS}ms（目标 ≤800ms）"
  else
    echo "ERROR: 未收到任何 SSE 帧"
    exit 1
  fi
else
  # 非流式：打印聚合 JSON
  curl -sS --fail-with-body --max-time 60 -X POST "$API_BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $ADAPTER_KEY" \
    -d "$PAYLOAD" | jq .
fi
