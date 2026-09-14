import { expect, test, vi } from "vitest";
import { ProviderRouter } from "./provider-router.js";
import type { Tenant } from "./store.js";

test("old tenants remain on Vercel; all lifecycle calls for Alibaba stay on Alibaba", async () => {
  const fake = () => ({ ensure: vi.fn(), execute: vi.fn(), stop: vi.fn() });
  const vercel = fake(), alibaba = fake(), router = new ProviderRouter({ vercel, alibaba });
  const old = { id: "old" } as Tenant;
  const ali = { id: "new", runtime_provider: "alibaba" } as Tenant;
  await router.ensure(old);
  await router.ensure(ali);
  await router.execute(ali, "session", "hi", async () => {});
  await router.stop(ali);
  expect(vercel.ensure).toHaveBeenCalledWith(old);
  expect(vercel.execute).not.toHaveBeenCalled();
  expect(vercel.stop).not.toHaveBeenCalled();
  expect(alibaba.ensure).toHaveBeenCalledWith(ali);
  expect(alibaba.execute).toHaveBeenCalledOnce();
  expect(alibaba.stop).toHaveBeenCalledWith(ali);
});

test("invalid provider never falls back to another cloud", () => {
  const router = new ProviderRouter({} as any);
  expect(() => router.forTenant({ runtime_provider: "unknown" } as any)).toThrow("UNKNOWN_RUNTIME_PROVIDER");
});
