#!/usr/bin/env bash
# 测试：孩子从不配合（中文/自言自语）逐渐过渡到配合，并在同一单元不同 topics 之间轮转
# 目标：
# 1. 证明 AI 能耐心应对不配合、中文输入、自言自语
# 2. 证明孩子配合后，AI 能在同一单元内自然切换不同内容（Nadiya → Larry Page → Ursula → Salman → jobs → creative → discussion）
# 3. 证明 conversation history 被完整传输给 DeepSeek

set -e

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TEXTBOOK_ID="unlock_l1_speaking&listening"
UNIT_ID="unit-listening-2"
DEVICE_ID="dev-uncooperative-001"

echo "=========================================="
echo "不配合 → 配合：同一单元 topics 轮转测试"
echo "Textbook: $TEXTBOOK_ID"
echo "Unit:     $UNIT_ID"
echo "Device:   $DEVICE_ID"
echo "=========================================="
echo ""

send() {
  local round="$1"
  local label="$2"
  local text="$3"

  echo "[Round $round] $label"
  echo "User: $text"
  RESPONSE=$(curl -s -X POST "$API_BASE_URL/vendor/text" \
    -H "Content-Type: application/json" \
    -d "{
      \"deviceId\": \"$DEVICE_ID\",
      \"asrText\": \"$text\",
      \"textbookId\": \"$TEXTBOOK_ID\",
      \"unitId\": \"$UNIT_ID\"
    }")
  echo "AI:   $(echo "$RESPONSE" | jq -r .responseText)"
  echo ""
}

# Phase 1: 不配合 + 中文 + 自言自语
send 1 "不配合" "I don't know."
send 2 "中文拒绝" "我不想说。"
send 3 "自言自语" "My toy car is red."
send 4 "中文自言自语" "今天天气很好。"
send 5 "跑题" "I want to eat pizza."

# Phase 2: 开始配合，在同一单元不同 topics 之间轮转
send 6 "配合：问起 Larry Page" "Who is Larry Page?"
send 7 "配合：问起 Ursula Burns" "What does Ursula Burns do?"
send 8 "配合：问起 Salman Khan" "Where is Salman Khan from?"
send 9 "配合：问起职业词汇 teacher" "What does a teacher do?"
send 10 "配合：问起 creative" "What does creative mean?"
send 11 "配合：讨论问题 best job" "I think teacher is the best job."
send 12 "联系上文：回到 Nadiya" "Is Nadiya Hussain creative too?"

echo "=========================================="
echo "完整对话记录（来自数据库，按时间正序）："
echo "=========================================="
psql "postgresql://xiong@localhost:5432/deda_db" -c "
  SELECT 
    to_char(\"createdAt\", 'HH24:MI:SS') as time,
    \"asrText\" as user_input,
    \"aiReply\" as ai_reply
  FROM conversations
  WHERE \"deviceId\" IN (
    SELECT id FROM devices WHERE \"deviceId\" = '$DEVICE_ID'
  )
  ORDER BY \"createdAt\" ASC;
"
echo "=========================================="
echo ""
echo "提示词拼接位置：src/modules/llm/llm.service.ts buildEnglishTutorPrompt()"
echo "当前服务器日志（LOG_LEVEL=debug）会打印完整 messages 数组。"
