export interface RuntimeOptions {
  agentId: string;
  displayName: string;
  payloadVersion: string;
  payloadLayout: "workspace" | "agent-kit-v1";
  envKeys: string[];
  modelInput: Array<"text" | "image">;
  mediaBinaries: boolean;
  skills?: string[];
  skillsLimits?: { maxSkillsPromptChars?: number };
  plugins: Array<{id: string; path: string; config?: Record<string, unknown>}>;
  tools: { profile: string; alsoAllow: string[]; deny: string[]; exec?: {security: "deny" | "allowlist" | "full"; ask: "off" | "on-miss" | "always"} };
}
export function normalizeRuntimeOptions(input?: Partial<Omit<RuntimeOptions, "tools">> & {tools?: Partial<RuntimeOptions["tools"]>}): RuntimeOptions;
export function verifyAgentKit(payloadRoot: string, runtime: RuntimeOptions): Record<string, unknown> | null;
export function verifyAgentKitArchive(archive: string, runtime: RuntimeOptions): Record<string, unknown> | null;
export function payloadWorkspace(payloadRoot: string, runtime: RuntimeOptions): string;
export function seedWorkspace(payloadRoot: string, dataRoot: string, runtime: RuntimeOptions): boolean;
export function createOpenClawConfig(input: {runtime?: Partial<RuntimeOptions>; workspace: string; payloadRoot: string; schedulerPath: string; modelId: string; gatewayPort?: number; modelProxyPort?: number}): any;

export interface AgentKitProfile { schemaVersion: 1; templateId: string; version: string; runtime: RuntimeOptions; archiveSha256: string; sourceCommit: string; }
export function readAgentKitProfile(filename: string, agentId: string, expectedVersion?: string): AgentKitProfile | null;
export function createAgentKitProfile(archive: string, input: Partial<RuntimeOptions>, templateId: string): AgentKitProfile;
export function assertAgentKitNode(version?: string): void;
export function agentKitFingerprint(profile: AgentKitProfile | null, env?: Record<string, string | undefined>): string[];
