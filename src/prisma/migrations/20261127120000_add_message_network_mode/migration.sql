-- 对话发起时的设备网络快照：wifi / 4g；NULL=未知。
-- 仅审计与对账用，比例统计见 conversation_network_daily。
ALTER TABLE "messages" ADD COLUMN "networkMode" TEXT;
