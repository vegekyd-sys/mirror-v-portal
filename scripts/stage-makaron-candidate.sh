#!/usr/bin/env bash
set -euo pipefail

# Stage an explicitly requested Makaron candidate from its isolated branch.
# Activation and rollback remain owned by deploy-mirror-v.sh.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test "$(git -C "$repo_root" branch --show-current)" = codex/makaron-portal-deploy
test -z "$(git -C "$repo_root" status --porcelain)"
revision="$(git -C "$repo_root" rev-parse --short=12 HEAD)"
target="${NEXUS_MIRROR_SSH_TARGET:-root@43.134.135.143}"
key="${NEXUS_MIRROR_SSH_KEY:-$HOME/.ssh/nexus-mirror-v-deploy-20260925}"
ssh_args=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes)

cd "$repo_root"
pnpm --filter @dealclaw/central-gateway build
pnpm --filter @dealclaw/runtime-manager build
pnpm --filter @dealclaw/credits-ledger build
VITE_NEXUS_ELASTIC=true pnpm --filter admin-web build

stage_dir="$(mktemp -d -t makaron-release)"
trap 'rm -rf "$stage_dir"' EXIT
mkdir -p "$stage_dir/release"
git archive HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml \
  packages/central-gateway packages/runtime-manager packages/credits-ledger \
  packages/agent-templates packages/admin-web/package.json deploy/mirror-v \
  | tar -xf - -C "$stage_dir/release"
for pkg in central-gateway runtime-manager credits-ledger; do
  cp -R "packages/$pkg/dist" "$stage_dir/release/packages/$pkg/dist"
done
cp -R packages/admin-web/dist "$stage_dir/release/packages/admin-web/dist"
tar -czf "$stage_dir/release.tgz" -C "$stage_dir/release" .
ssh "${ssh_args[@]}" "$target" 'install -d -m 755 /opt/nexus/releases'
scp "${ssh_args[@]}" "$stage_dir/release.tgz" "$target:/opt/nexus/releases/$revision.tgz"
ssh "${ssh_args[@]}" "$target" bash -s -- "$revision" <<'REMOTE'
set -euo pipefail
revision="$1"
release="/opt/nexus/releases/$revision"
test ! -e "$release"
install -d -m 755 "$release"
tar -xzf "/opt/nexus/releases/$revision.tgz" -C "$release"
rm "/opt/nexus/releases/$revision.tgz"
export PATH=/root/.nvm/versions/node/v22.22.1/bin:$PATH
cd "$release"
pnpm install --prod --frozen-lockfile
REMOTE
printf 'Staged Makaron candidate %s; no services activated\n' "$revision"
