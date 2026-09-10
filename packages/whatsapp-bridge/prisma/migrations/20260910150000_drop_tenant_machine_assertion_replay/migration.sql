-- Drop the tenant-machine assertion replay ledger. The short-lived HMAC
-- assertion path was removed; nothing reads or writes this table anymore.
DROP TABLE IF EXISTS "TenantMachineAssertionReplay";
