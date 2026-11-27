-- 家长手机品牌：小程序上报的当前快照，用于用户画像页终端分布。
ALTER TABLE "users" ADD COLUMN "phoneBrand" TEXT;
ALTER TABLE "users" ADD COLUMN "phoneBrandReportedAt" TIMESTAMP(3);
