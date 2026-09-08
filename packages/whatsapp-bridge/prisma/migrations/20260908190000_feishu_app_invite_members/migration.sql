-- 人类客服邀请名单 per-app 化：FeishuApp 表新增三列，
-- 让每个飞书应用（每个租户）存自己的邀请 open_id / 手机号 / 邮箱，
-- 拉群时按 app 读取，而不是读桥接全局 FEISHU_INVITE_* env。
ALTER TABLE "FeishuApp" ADD COLUMN "inviteOpenIds" TEXT;
ALTER TABLE "FeishuApp" ADD COLUMN "inviteMobiles" TEXT;
ALTER TABLE "FeishuApp" ADD COLUMN "inviteEmails" TEXT;
