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
  (cd "$repo_root" && pnpm --filter @dealclaw/central-gateway build && pnpm --filter @dealclaw/runtime-manager build && pnpm --filter @dealclaw/credits-ledger build && VITE_NEXUS_ELASTIC=true pnpm --filter admin-web build)
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/release"
  # Ship only the elastic control plane and approved public templates. The
  # legacy DealClaw payload contains customer data and must not land here.
  git -C "$repo_root" archive HEAD -- package.json pnpm-lock.yaml pnpm-workspace.yaml \
    packages/central-gateway packages/runtime-manager packages/credits-ledger packages/agent-templates \
    packages/admin-web/package.json deploy/mirror-v \
    | tar -xf - -C "$tmp/release"
  for pkg in central-gateway runtime-manager credits-ledger; do
    cp -R "$repo_root/packages/$pkg/dist" "$tmp/release/packages/$pkg/dist"
  done
  cp -R "$repo_root/packages/admin-web/dist" "$tmp/release/packages/admin-web/dist"
  cp "$repo_root/packages/central-gateway/public/onboard/index.html" "$tmp/release/packages/central-gateway/public/onboard/index.html"
  tar -czf "$tmp/release.tgz" -C "$tmp/release" .
  ssh "${ssh_args[@]}" "$target" "install -d -m 755 /opt/nexus/releases"
  scp "${ssh_args[@]}" "$tmp/release.tgz" "$target:/opt/nexus/releases/$sha.tgz"
  ssh "${ssh_args[@]}" "$target" "set -e; install -d -m 755 /opt/nexus/releases/$sha; tar -xzf /opt/nexus/releases/$sha.tgz -C /opt/nexus/releases/$sha; rm /opt/nexus/releases/$sha.tgz; export PATH=$node_bin:\$PATH; cd /opt/nexus/releases/$sha; pnpm install --prod --frozen-lockfile"
  echo "Staged $sha on $target"
}

activate() {
  ssh "${ssh_args[@]}" "$target" bash -s -- "$sha" <<'REMOTE'
set -euo pipefail
revision="$1"
release="/opt/nexus/releases/$revision"
test -f "$release/packages/runtime-manager/dist/index.js"
test -f "$release/packages/admin-web/dist/index.html"
test -f /opt/nexus/data/config.json
test -f /opt/nexus/data/central.env
test -f /opt/nexus/data/ledger.env
install -m 644 "$release/deploy/mirror-v/nexus-credits-ledger.service" /etc/systemd/system/nexus-credits-ledger.service
if [[ -f "$release/deploy/mirror-v/nexus-cert-renew.service" ]]; then
  install -m 644 "$release/deploy/mirror-v/nexus-cert-renew.service" /etc/systemd/system/nexus-cert-renew.service
  install -m 644 "$release/deploy/mirror-v/nexus-cert-renew.timer" /etc/systemd/system/nexus-cert-renew.timer
fi
if [[ -f /etc/systemd/system/nexus-origin-tunnel.service && -f "$release/deploy/mirror-v/nexus-origin-tunnel.service" ]]; then
  install -m 644 "$release/deploy/mirror-v/nexus-origin-tunnel.service" /etc/systemd/system/nexus-origin-tunnel.service
fi
systemctl daemon-reload
old="$(readlink -f /opt/nexus/current || true)"
if [[ -n "$old" ]]; then ln -sfn "$old" /opt/nexus/previous; fi
ln -sfn "$release" /opt/nexus/.current-next
mv -Tf /opt/nexus/.current-next /opt/nexus/current
systemctl restart nexus-runtime-manager nexus-central-gateway nexus-credits-ledger
for attempt in {1..15}; do
  if curl -fsS http://127.0.0.1:8098/healthz >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8098/onboard/templates >/dev/null 2>&1 \
    && curl -fsS http://127.0.0.1:8081/healthz >/dev/null 2>&1; then
    # A healthy catalog is insufficient: Feishu must be able to read/decode
    # every listed avatar across origins. Failure follows normal rollback.
    if ! /root/.nvm/versions/node/v22.22.1/bin/node "$release/packages/central-gateway/dist/check-template-avatars.js" --catalog http://127.0.0.1:8098/onboard/templates; then
      echo 'Public template avatar preflight failed' >&2
      break
    fi
    cp /etc/nginx/nexus-portal.locations.conf /opt/nexus/data/nginx-portal.previous.conf
    install -m 644 "$release/deploy/mirror-v/nginx-locations.conf" /etc/nginx/nexus-portal.locations.conf
    if [[ -f "$release/deploy/mirror-v/nginx-onboard-maps.conf" ]]; then
      install -m 644 "$release/deploy/mirror-v/nginx-onboard-maps.conf" /etc/nginx/conf.d/nexus-onboard-maps.conf
    fi
    if [[ -f /etc/letsencrypt/live/43.134.135.143/fullchain.pem ]]; then
      install -m 644 "$release/deploy/mirror-v/nginx-tls.conf" /etc/nginx/sites-enabled/nexus-tls.conf
    fi
    # Preserve an already-enabled HTTPS origin on later control-plane releases.
    # Initial tunnel enablement is a separate, explicit host operation.
    if [[ -f /etc/nginx/sites-enabled/nexus-portal-origin.conf && -f "$release/deploy/mirror-v/nginx-origin.conf" ]]; then
      install -m 644 "$release/deploy/mirror-v/nginx-origin.conf" /etc/nginx/sites-enabled/nexus-portal-origin.conf
    fi
    if ! nginx -t >/dev/null 2>&1; then
      cp /opt/nexus/data/nginx-portal.previous.conf /etc/nginx/nexus-portal.locations.conf
      echo 'Nginx config failed validation' >&2
      break
    fi
    systemctl reload nginx
    systemctl try-restart nexus-origin-tunnel.service 2>/dev/null || true
    if [[ -f /etc/letsencrypt/live/43.134.135.143/fullchain.pem ]]; then
      systemctl enable --now nexus-cert-renew.timer
      if ! curl --noproxy '*' -fsS --resolve 43.134.135.143:443:127.0.0.1 https://43.134.135.143/healthz >/dev/null 2>&1; then
        echo 'Origin TLS failed health check' >&2
        break
      fi
    fi
    admin_ready=0
    for admin_attempt in {1..10}; do
      if curl -fsS http://127.0.0.1/admin/ >/dev/null 2>&1 \
        && curl -fsS http://127.0.0.1/admin >/dev/null 2>&1; then
        admin_ready=1
        break
      fi
      sleep 1
    done
    if [[ "$admin_ready" != 1 ]]; then
      cp /opt/nexus/data/nginx-portal.previous.conf /etc/nginx/nexus-portal.locations.conf
      systemctl reload nginx
      echo 'Admin page failed health check' >&2
      break
    fi
    echo "Mirror V Portal release $revision healthy"
    exit 0
  fi
  sleep 2
done
if [[ -n "$old" ]]; then
  ln -sfn "$old" /opt/nexus/.current-next
  mv -Tf /opt/nexus/.current-next /opt/nexus/current
  systemctl restart nexus-runtime-manager nexus-central-gateway
  if [[ -f "$old/packages/credits-ledger/dist/index.js" ]]; then
    systemctl restart nexus-credits-ledger
  else
    systemctl stop nexus-credits-ledger
  fi
fi
echo 'Mirror V Portal release failed health checks; previous release restored when present' >&2
exit 1
REMOTE
}

case "$action" in
  stage) stage ;;
  activate) activate ;;
  deploy) stage; activate ;;
  *) echo "Usage: $0 [stage|activate|deploy] [commit-sha]" >&2; exit 2 ;;
esac
