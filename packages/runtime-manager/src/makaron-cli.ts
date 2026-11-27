import path from "node:path";

/** The Makaron CLI V runs (/opt/makaron-cli-current → 0.17.30 on 2026-11-27): images, video, music, design. */
export const V_RELEASE_MAKARON_CLI_VERSION = "0.17.30";

/**
 * Shell that makes the snapshot's preinstalled CLI (<root>/nexus/tools-node) answer to `makaron`,
 * `makaron-cli` and `npx makaron-cli`. Like V, the package is linked into the agent's global npm
 * prefix (sandbox-exec.mjs sets NPM_CONFIG_PREFIX=agent-data/npm); otherwise npx cannot see it and
 * fetches the newest release, so two versions run side by side. A tenant's own
 * `npm install -g makaron-cli` replaces these links, and all three spellings move together.
 */
export function makaronCliLinkScript(root = "/vercel/sandbox") {
  const pkg = path.posix.join(root, "nexus/tools-node/node_modules/makaron-cli");
  const toolsBin = path.posix.join(root, "nexus/tools/bin");
  const prefix = path.posix.join(root, "agent-data/npm");
  const viaPrefix = "../lib/node_modules/makaron-cli/bin/makaron.mjs";
  const steps = [`mkdir -p ${toolsBin} ${prefix}/bin ${prefix}/lib/node_modules`, `ln -sfn ${pkg} ${prefix}/lib/node_modules/makaron-cli`];
  for (const name of ["makaron", "makaron-cli"]) {
    steps.push(`ln -sfn ${pkg}/bin/makaron.mjs ${toolsBin}/${name}`, `ln -sfn ${viaPrefix} ${prefix}/bin/${name}`);
  }
  return steps.join(" && ");
}

/** Fails the build unless every spelling the Skills use reports `version`; npx may not download. */
export function makaronCliVerifyScript(version: string, root = "/vercel/sandbox") {
  const prefix = path.posix.join(root, "agent-data/npm");
  const toolsBin = path.posix.join(root, "nexus/tools/bin");
  return [
    `export NPM_CONFIG_PREFIX=${prefix} PATH=${prefix}/bin:${toolsBin}:$PATH`,
    `cd ${root}`,
    `for cli in ${toolsBin}/makaron makaron makaron-cli "npx --offline makaron-cli"; do got=$($cli --version) && echo "$cli $got" && [ "$got" = "${version}" ] || { echo "MAKARON_CLI_VERSION_MISMATCH: $cli"; exit 1; }; done`,
  ].join(" && ");
}
