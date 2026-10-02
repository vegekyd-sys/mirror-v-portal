import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { VercelProvider } from "./provider.js";
import { templateRecord } from "./template-payload.js";
import { agentKitFingerprint, assertAgentKitNode, createAgentKitProfile, readAgentKitProfile, normalizeRuntimeOptions } from "../runtime/agent-config.mjs";
import { execFileSync } from "node:child_process";

const runtime = normalizeRuntimeOptions({agentId:"makaron",payloadVersion:"makaron.v2.0.0",payloadLayout:"agent-kit-v1",envKeys:["MAKARON_API_KEY"],skills:["image"],plugins:[]});
const profile = {schemaVersion:1,templateId:"makaron",version:runtime.payloadVersion,runtime,archiveSha256:"a".repeat(64),sourceCommit:"b".repeat(40)};
const model = {id:"anthropic/claude-sonnet-4.6",baseUrl:"https://openrouter.ai/api/v1",apiKey:"isolated-model-secret"};
const tenant = {id:"isolated-makaron",template_id:"makaron",template_version:"makaron.v2.0.0",template_snapshot_id:"pinned-old-snapshot",state:"sleeping",runtime_env:{MAKARON_API_KEY:"isolated-service-secret"}} as any;
function config(dataDir: string) {
  return {dataDir,encryptionKey:"0".repeat(64),sandboxPrefix:"test",snapshotId:"legacy",model:{id:"deepseek",baseUrl:"https://api.deepseek.com",apiKey:"legacy-model-secret"},
    templates:{makaron:{version:"makaron.v2.0.0",snapshotId:"current-different-snapshot",model,modelVersion:"makaron.v2.0.0",agentKit:{archiveSha256:profile.archiveSha256,sourceCommit:profile.sourceCommit,requiredEnvKeys:["MAKARON_API_KEY"]}}}} as any;
}

describe("snapshot-pinned agent-kit runtime", () => {
  it("never uses a global owner service key or allocates a sandbox before tenant binding", async () => {
    const provider = new VercelProvider(config("/unused"));
    const allocate = vi.spyOn(provider as any,"create");
    const old = process.env.MAKARON_API_KEY; process.env.MAKARON_API_KEY="controller-owner-secret";
    try { await expect(provider.ensure({...tenant,runtime_env:{}})).rejects.toThrow("RUNTIME_ENV_KEY_MISSING:MAKARON_API_KEY"); expect(allocate).not.toHaveBeenCalled(); }
    finally {if(old===undefined)delete process.env.MAKARON_API_KEY;else process.env.MAKARON_API_KEY=old;}
  });
  it("applies the private planner only to its matching template version and fails missing override closed", async () => {
    const cfg=config("/unused");const p=new VercelProvider(cfg);
    expect((p as any).modelForTenant(tenant)).toEqual(model);
    expect((p as any).modelForTenant({template_id:"mirror-v",template_version:"old"})).toEqual(cfg.model);
    expect((p as any).modelForTenant({template_id:"dealclaw"})).toEqual(cfg.model);
    expect(()=> (p as any).modelForTenant({...tenant,template_version:"makaron.v1.0.0"})).toThrow("TEMPLATE_MODEL_PROFILE_MISMATCH");
    delete cfg.templates.makaron.model;
    await expect(p.ensure(tenant)).rejects.toThrow("TEMPLATE_MODEL_NOT_CONFIGURED");
    delete cfg.templates.makaron;await expect(p.ensure(tenant)).rejects.toThrow("TEMPLATE_MODEL_NOT_CONFIGURED");
  });
  it("boots the actual tenant with private env and refreshes helpers without copying keys into deployed files", async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kit-provider-"));
    const uploaded:any[]=[];let boot:any;
    const sbx={name:"isolated",update:async()=>{},readFileToBuffer:async()=>null,writeFiles:async(files:any[])=>{uploaded.push(...files);},runCommand:async(options:any)=>{boot=options;return {exitCode:0,stdout:async()=>'{"processReused":false}',stderr:async()=>""};}};
    try {
      const p=new VercelProvider(config(dir));const create=vi.spyOn(p as any,"create").mockResolvedValue(sbx);
      await p.ensure(tenant);expect(create).toHaveBeenCalledWith(tenant,"test-isolated-makaron");
      expect(boot.env).toMatchObject({NEXUS_AGENT_ID:"makaron",NEXUS_EXPECT_AGENT_KIT:"1",NEXUS_MODEL_ID:model.id,NEXUS_MODEL_KEY:model.apiKey,MAKARON_API_KEY:"isolated-service-secret"});
      expect(uploaded.some(f=>f.path.endsWith("agent-config.mjs"))).toBe(true);
      expect(uploaded.some(f=>f.path.endsWith("agent-kit-runtime.json"))).toBe(false); // baked profile never overwritten by latest catalog
      const bytes=uploaded.map(f=>f.content.toString()).join("\n");expect(bytes).not.toContain("isolated-model-secret");expect(bytes).not.toContain("isolated-service-secret");
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });
  it("preserves a model profile's original version when rebuilding the public pointer", () => {
    const prior=config("/unused").templates.makaron;
    const next=templateRecord(prior,{version:"makaron.v3.0.0",snapshotId:"next",builtAt:new Date("2026-10-03"),agentKit:prior.agentKit});
    expect(next.modelVersion).toBe("makaron.v2.0.0");expect(next.model).toEqual(model);expect(next.listed).toBe(true);
  });
  it("checks profile identity, excludes inline secrets and detects tenant key rotation without changing legacy fingerprints", () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kit-profile-"));const file=path.join(dir,"profile.json");
    try {
      expect(readAgentKitProfile(file,"makaron")).toBeNull();fs.writeFileSync(file,JSON.stringify(profile));
      expect(readAgentKitProfile(file,"makaron")?.runtime.agentId).toBe("makaron");expect(()=>readAgentKitProfile(file,"mirror-v")).toThrow("AGENT_KIT_PROFILE_INVALID");expect(()=>readAgentKitProfile(file,"makaron","makaron.v1.0.0")).toThrow("AGENT_KIT_TENANT_VERSION_MISMATCH");
      expect(agentKitFingerprint(null)).toEqual([]);
      expect(agentKitFingerprint(profile as any,{MAKARON_API_KEY:"old"})).not.toEqual(agentKitFingerprint(profile as any,{MAKARON_API_KEY:"new"}));
      fs.writeFileSync(file,JSON.stringify({...profile,runtime:{...runtime,plugins:[{id:"tools",path:"plugins/tools",config:{apiKey:"unsafe"}}]}}));
      expect(()=>readAgentKitProfile(file,"makaron")).toThrow("AGENT_KIT_INLINE_SECRET_FORBIDDEN");
      expect(()=>assertAgentKitNode("24.1.0")).toThrow("AGENT_KIT_NODE_REQUIRES_24_19");expect(()=>assertAgentKitNode("22.22.1")).toThrow();expect(()=>assertAgentKitNode("24.19.0")).not.toThrow();
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
  it("verifies all source bytes and records the exact archive/source before billed building", () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kit-archive-profile-"));const payload=path.join(dir,"payload");const archive=path.join(dir,"kit.tar");
    try {
      fs.mkdirSync(path.join(payload,"workspace/skills/image"),{recursive:true});
      const files={"workspace/AGENTS.md":"isolated","workspace/skills/image/SKILL.md":"image skill"};
      for(const [rel,text]of Object.entries(files))fs.writeFileSync(path.join(payload,rel),text);
      fs.writeFileSync(path.join(payload,"payload-manifest.json"),JSON.stringify({schemaVersion:1,id:"makaron",agentId:"makaron",layout:"agent-kit-v1",workspace:"workspace",version:runtime.payloadVersion,sources:{repositoryCommit:"b".repeat(40)},craft:{topLevelSkillCount:1,topLevelSkills:[{name:"image"}]},files:Object.entries(files).map(([rel,text])=>({path:rel,bytes:Buffer.byteLength(text),sha256:createHash("sha256").update(text).digest("hex")}))}));
      execFileSync("tar",["-cf",archive,"-C",payload,"."]);const got=createAgentKitProfile(archive,runtime,"makaron");
      expect(got.sourceCommit).toBe("b".repeat(40));expect(got.archiveSha256).toBe(createHash("sha256").update(fs.readFileSync(archive)).digest("hex"));expect(JSON.stringify(got)).not.toContain("apiKey\"");
      fs.writeFileSync(path.join(payload,"workspace/AGENTS.md"),"changed");execFileSync("tar",["-cf",archive,"-C",payload,"."]);
      expect(()=>createAgentKitProfile(archive,runtime,"makaron")).toThrow("AGENT_KIT_CHECKSUM_MISMATCH");
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
