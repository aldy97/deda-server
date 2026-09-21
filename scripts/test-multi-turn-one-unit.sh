#!/usr/bin/env bash
# 单单元多轮对话测试
# 目标：证明同一单元内的 conversation history 被完整传输给 DeepSeek
# 测试场景：中文输入、偏离话题、语法错误、联系上文

set -e

API_BASE_URL="${API_BASE_URL:-http://localhost:3000}"
TEXTBOOK_ID="unlock_l1_speaking&listening"
UNIT_ID="unit-listening-2"
DEVICE_ID="dev-one-unit-001"

echo "=========================================="
echo "单单元多轮对话测试"
echo "Textbook: $TEXTBOOK_ID"
echo "Unit:     $UNIT_ID"
echo "Device:   $DEVICE_ID"
echo "=========================================="
echo ""

# Round 1: 正常英文开场
echo "[Round 1] 正常英文开场"
echo "User: Who is Nadiya Hussain?"
ROUND1=$(curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"Who is Nadiya Hussain?\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"$UNIT_ID\"
  }")
echo "AI:   $(echo "$ROUND1" | jq -r .responseText)"
echo ""

# Round 2: 中文输入
echo "[Round 2] 中文输入测试"
echo "User: 她来自哪里？"
ROUND2=$(curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"她来自哪里？\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"$UNIT_ID\"
  }")
echo "AI:   $(echo "$ROUND2" | jq -r .responseText)"
echo ""

# Round 3: 联系上文
echo "[Round 3] 联系上文（代词 she 指代 Nadiya）"
echo "User: What jobs does she have?"
ROUND3=$(curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"What jobs does she have?\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"$UNIT_ID\"
  }")
echo "AI:   $(echo "$ROUND3" | jq -r .responseText)"
echo ""

# Round 4: 语法有问题的英语
echo "[Round 4] 语法有问题的英语"
echo "User: She are a chef."
ROUND4=$(curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"She are a chef.\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"$UNIT_ID\"
  }")
echo "AI:   $(echo "$ROUND4" | jq -r .responseText)"
echo ""

# Round 5: 偏离单元话题
echo "[Round 5] 偏离单元话题"
echo "User: I want to play football."
ROUND5=$(curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"I want to play football.\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"$UNIT_ID\"
  }")
echo "AI:   $(echo "$ROUND5" | jq -r .responseText)"
echo ""

# Round 6: 拉回单元并联系上文
echo "[Round 6] 拉回单元并联系上文"
echo "User: Is she creative?"
ROUND6=$(curl -s -X POST "$API_BASE_URL/vendor/text" \
  -H "Content-Type: application/json" \
  -d "{
    \"deviceId\": \"$DEVICE_ID\",
    \"asrText\": \"Is she creative?\",
    \"textbookId\": \"$TEXTBOOK_ID\",
    \"unitId\": \"$UNIT_ID\"
  }")
echo "AI:   $(echo "$ROUND6" | jq -r .responseText)"
echo ""

echo "=========================================="
echo "完整对话记录（来自数据库）："
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
