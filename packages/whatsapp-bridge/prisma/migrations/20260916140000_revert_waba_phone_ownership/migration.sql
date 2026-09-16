-- 回滚「共享 WABA + 手机号级归属」（2026-09-16 决策）。
--
-- 目标语义：归属回到 **WABA 级** —— 一个 supplier 绑一个 WABA，一个 WABA 只属于一个 supplier。
-- WabaPhone 不再持有租户，「这个号属于谁」由 WabaOnboarding(partnerCustomerId, wabaId,
-- status='CONNECTED') 决定。
--
-- 历史迁移 20260915230000 / 20260915234500 已经在本套库上执行过（supplierId 列与
-- phoneNumber 全局唯一索引都在），这里撤销它们的 DDL，使库结构与本分支 schema.prisma 对齐。
-- 执行时绑定数据为空（WabaPhone / WabaOnboarding 均 0 行），无数据迁移风险。

-- 1) 去掉手机号全局唯一：旧模型允许同一号码出现在不同 WABA 下，
--    唯一性由既有的 (wabaId, phoneNumber) 唯一约束兜底。
DROP INDEX IF EXISTS "WabaPhone_phoneNumber_key";

-- 2) 去掉租户列及其索引（回滚后归属不再落在号码行上）。
DROP INDEX IF EXISTS "WabaPhone_supplierId_idx";
ALTER TABLE "WabaPhone" DROP COLUMN IF EXISTS "supplierId";
