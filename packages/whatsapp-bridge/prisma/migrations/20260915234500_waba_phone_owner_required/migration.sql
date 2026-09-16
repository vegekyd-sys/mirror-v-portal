-- WabaPhone.supplierId 去掉列默认值：每一行都必须显式指定归属。
--
-- 上一条迁移（20260915230000）的 DEFAULT '' 只是**回填存量行**的机制 —— WabaPhone
-- 建表于 20260905100000 时没有 supplierId 列，而当时 upsertWabaPhones 挂在读取路径上
-- 自动 create 行，所以 09-05~09-15 之间跑过的库里会有一批无主行，加列时必须有默认值。
--
-- 但把这个默认值留在列上有代价：Prisma 会据此把 supplierId 变成 create 时的可选字段，
-- 「每一行都必须有主」就从编译期保证降级成运行时约定 —— 正是手机号级归属最不该松的一环。
-- 回填已经做完，默认值的使命到此为止。
--
-- 存量的 '' 行原样保留（视为无主，claimWabaPhonesForTenant / adminWabaImport 会认领它们）；
-- 此后任何新行都必须带 supplierId，否则 INSERT 直接失败。

ALTER TABLE "WabaPhone" ALTER COLUMN "supplierId" DROP DEFAULT;
