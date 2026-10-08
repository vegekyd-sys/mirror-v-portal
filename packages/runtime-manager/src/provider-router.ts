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
  openSignatureValid(...args: Parameters<NonNullable<RuntimeProvider["openSignatureValid"]>>) { return this.forTenant(args[0]).openSignatureValid?.(...args) ?? false; }
  serviceUrl(...args: Parameters<NonNullable<RuntimeProvider["serviceUrl"]>>) {
    const provider = this.forTenant(args[0]);
    if (!provider.serviceUrl) throw Error("SERVICE_NOT_EXPOSED");
    return provider.serviceUrl(...args);
  }
  runningPublicUrls(...args: Parameters<NonNullable<RuntimeProvider["runningPublicUrls"]>>) { return this.forTenant(args[0]).runningPublicUrls?.(...args) ?? Promise.resolve(null); }
}
