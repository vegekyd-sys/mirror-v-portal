#!/usr/bin/env bash
set -euo pipefail

# Deploy only a committed dev revision. Config, credentials and the database
# stay outside the release directory on the server.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
action="${1:-deploy}"
target="${NEXUS_MIRROR_SSH_TARGET:-root@43.134.135.143}"
key="${NEXUS_MIRROR_SSH_KEY:-$HOME/.ssh/nexus-mirror-v-deploy-20260925}"
sha="${2:-$(git -C "$repo_root" rev-parse --short=12 HEAD)}"
ssh_args=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes)
node_bin=/root/.nvm/versions/node/v22.22.1/bin

case "$sha" in
  *[!a-f0-9]*|'') echo "Invalid revision" >&2; exit 2 ;;
esac

stage() {
  if [[ "$(git -C "$repo_root" branch --show-current)" != dev ]]; then
    echo "Deploy from the dev branch only" >&2; exit 2
  fi
  if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
    echo "Commit or remove local changes before staging" >&2; exit 2
  fi
  (cd "$repo_root" && pnpm --filter @dealclaw/central-gateway build && pnpm --filter @dealclaw/runtime-manager build)
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/release"
  # Ship only the elastic control plane and approved public templates. The
  # legacy DealClaw payload contains customer data and must not land here.
  git -C "$repo_root" archive HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml \
    packages/central-gateway packages/runtime-manager packages/agent-templates \
    | tar -xf - -C "$tmp/release"
  for pkg in central-gateway runtime-manager; do
    cp -R "$repo_root/packages/$pkg/dist" "$tmp/release/packages/$pkg/dist"
  done
  tar -czf "$tmp/release.tgz" -C "$tmp/release" .
  ssh "${ssh_args[@]}" "$target" "install -d -m 755 /opt/nexus/releases"
  scp "${ssh_args[@]}" "$tmp/release.tgz" "$target:/opt/nexus/releases/$sha.tgz"
  ssh "${ssh_args[@]}" "$target" "set -e; install -d -m 755 /opt/nexus/releases/$sha; tar -xzf /opt/nexus/releases/$sha.tgz -C /opt/nexus/releases/$sha; rm /opt/nexus/releases/$sha.tgz; export PATH=$node_bin:\$PATH; cd /opt/nexus/releases/$sha; pnpm install --prod --frozen-lockfile"
  echo "Staged $sha on $target"
}

activate() {
  ssh "${ssh_args[@]}" "$target" "set -e; test -d /opt/nexus/releases/$sha; test -f /opt/nexus/data/config.json; test -f /opt/nexus/data/central.env; old=\$(readlink -f /opt/nexus/current || true); if [ -n \"\$old\" ]; then ln -sfn \"\$old\" /opt/nexus/previous; fi; ln -sfn /opt/nexus/releases/$sha /opt/nexus/.current-next; mv -Tf /opt/nexus/.current-next /opt/nexus/current; systemctl restart nexus-runtime-manager nexus-central-gateway; for attempt in 1 2 3 4 5 6 7 8 9 10; do if curl -fsS http://127.0.0.1:8098/healthz >/dev/null && curl -fsS http://127.0.0.1:8098/onboard/templates >/dev/null; then echo 'Nexus release $sha healthy'; exit 0; fi; sleep 2; done; if [ -n \"\$old\" ]; then ln -sfn \"\$old\" /opt/nexus/.current-next; mv -Tf /opt/nexus/.current-next /opt/nexus/current; systemctl restart nexus-runtime-manager nexus-central-gateway; fi; echo 'Nexus release failed health checks; previous release restored when present' >&2; exit 1"
}

case "$action" in
  stage) stage ;;
  activate) activate ;;
  deploy) stage; activate ;;
  *) echo "Usage: $0 [stage|activate|deploy] [commit-sha]" >&2; exit 2 ;;
esac
