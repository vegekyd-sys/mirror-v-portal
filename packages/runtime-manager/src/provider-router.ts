import type { RuntimeProvider } from "./provider.js";
import type { Tenant } from "./store.js";

export class ProviderRouter implements RuntimeProvider {
  constructor(readonly providers: { vercel: RuntimeProvider; alibaba: RuntimeProvider }) {}
  forTenant(tenant: Tenant) {
    const name = tenant.runtime_provider ?? "vercel";
    if (name !== "vercel" && name !== "alibaba") throw Error("UNKNOWN_RUNTIME_PROVIDER");
    return this.providers[name];
  }
  ensure(...args: Parameters<RuntimeProvider["ensure"]>) { return this.forTenant(args[0]).ensure(...args); }
  execute(...args: Parameters<RuntimeProvider["execute"]>) { return this.forTenant(args[0]).execute(...args); }
  stop(...args: Parameters<RuntimeProvider["stop"]>) { return this.forTenant(args[0]).stop(...args); }
}
