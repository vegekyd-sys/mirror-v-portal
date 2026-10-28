#!/usr/bin/env bash
set -euo pipefail

# Deploy only a committed dev revision. Config, credentials and the database
# stay outside the release directory on the server.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
action="${1:-deploy}"
target="${NEXUS_MIRROR_SSH_TARGET:-root@43.134.135.143}"
key="${NEXUS_MIRROR_SSH_KEY:-$HOME/.ssh/nexus-mirror-v-deploy-20260925}"
sha="${2:-$(git -C "$repo_root" rev-parse --short=12 HEAD)}"
ssh_args=(-i "$key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15)
node_bin=/root/.nvm/versions/node/v22.22.1/bin
github_repo=vegekyd-sys/mirror-v-portal
# Paths whose change requires rebuilding the control-plane dist.
build_inputs=(package.json pnpm-lock.yaml pnpm-workspace.yaml packages/central-gateway
  packages/runtime-manager packages/credits-ledger packages/admin-web)

case "$sha" in
  *[!a-f0-9]*|'') echo "Invalid revision" >&2; exit 2 ;;
esac

# The server fetches the commit from GitHub and builds it there: uploading a
# release from a slow uplink stalls, while the host reaches GitHub quickly.
# Only a commit already on GitHub `dev` with green CI can be staged this way.
stage() {
  git -C "$repo_root" fetch -q github dev
  full="$(git -C "$repo_root" rev-parse --verify "$sha^{commit}")"
  sha="${full:0:12}"
  if ! git -C "$repo_root" merge-base --is-ancestor "$full" github/dev; then
    echo "$sha is not on GitHub dev; push it first" >&2; exit 2
  fi
  if [[ "${NEXUS_SKIP_CI_CHECK:-}" != 1 ]]; then
    ci="$(gh run list --repo "$github_repo" --commit "$full" --json status,conclusion -q '.[0] | "\(.status) \(.conclusion)"' 2>/dev/null || true)"
    [[ "$ci" == "completed success" ]] || { echo "CI for $sha is '${ci:-missing}', not green" >&2; exit 2; }
  fi
  # Reuse the running release's build when this commit leaves the build inputs
  # untouched (payload-only releases); otherwise build on the host.
  current="$(ssh "${ssh_args[@]}" "$target" 'basename "$(readlink -f /opt/nexus/current)"' || true)"
  reuse=""
  if current_full="$(git -C "$repo_root" rev-parse --verify -q "$current^{commit}")" \
    && git -C "$repo_root" diff --quiet "$current_full" "$full" -- "${build_inputs[@]}"; then
    reuse="$current"
  fi
  echo "Staging $sha on $target (${reuse:+reusing build of $reuse}${reuse:-building on host})"
  ssh "${ssh_args[@]}" "$target" bash -s -- "$full" "$sha" "$reuse" <<'REMOTE'
set -euo pipefail
export PATH=/root/.nvm/versions/node/v22.22.1/bin:$PATH
full="$1"; rev="$2"; reuse="${3:-}"  # ssh drops an empty argument
release="/opt/nexus/releases/$rev"
if [[ -f "$release/.staged" ]]; then echo "$rev already staged"; exit 0; fi
for live in /opt/nexus/current /opt/nexus/previous; do
  if [[ "$(readlink -f "$live" 2>/dev/null)" == "$release" ]]; then echo "$rev is $live; not restaging it" >&2; exit 0; fi
done
work="$(mktemp -d /opt/nexus/stage.XXXXXX)"
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 "https://codeload.github.com/vegekyd-sys/mirror-v-portal/tar.gz/$full" \
  | tar -xz -C "$work" --strip-components=1
rm -rf "$release"; install -d -m 755 "$release"
# Ship only the elastic control plane and approved public templates. The
# legacy DealClaw payload contains customer data and must not land here.
tar -C "$work" -cf - package.json pnpm-lock.yaml pnpm-workspace.yaml \
  packages/central-gateway packages/runtime-manager packages/credits-ledger packages/agent-templates \
  packages/admin-web/package.json deploy/mirror-v | tar -xf - -C "$release"
dists=(central-gateway/dist runtime-manager/dist credits-ledger/dist admin-web/dist central-gateway/public/onboard/index.html)
if [[ -n "$reuse" ]]; then
  from="/opt/nexus/releases/$reuse/packages"
else
  cd "$work"
  # A 2 GB host: cap the heap and lean on swap rather than racing the services.
  export NODE_OPTIONS=--max-old-space-size=1024
  nice pnpm install --frozen-lockfile --prefer-offline \
    --filter @dealclaw/central-gateway --filter @dealclaw/runtime-manager \
    --filter @dealclaw/credits-ledger --filter admin-web
  nice pnpm --filter @dealclaw/central-gateway build
  nice pnpm --filter @dealclaw/runtime-manager build
  nice pnpm --filter @dealclaw/credits-ledger build
  VITE_NEXUS_ELASTIC=true nice pnpm --filter admin-web build
  unset NODE_OPTIONS
  from="$work/packages"
fi
for d in "${dists[@]}"; do rm -rf "$release/packages/$d"; cp -R "$from/$d" "$release/packages/$d"; done
cd "$release" && pnpm install --prod --frozen-lockfile --prefer-offline
touch "$release/.staged"
echo "Staged $rev"
REMOTE
}

# Old path: build here and upload the release. Needs a fast uplink.
stage_local() {
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
  ssh "${ssh_args[@]}" "$target" "set -e; install -d -m 755 /opt/nexus/releases/$sha; tar -xzf /opt/nexus/releases/$sha.tgz -C /opt/nexus/releases/$sha; rm /opt/nexus/releases/$sha.tgz; export PATH=$node_bin:\$PATH; cd /opt/nexus/releases/$sha; pnpm install --prod --frozen-lockfile; touch .staged"
  echo "Staged $sha on $target"
}

activate() {
  ssh "${ssh_args[@]}" "$target" FORCE="${NEXUS_FORCE_ACTIVATE:-}" bash -s -- "$sha" <<'REMOTE'
set -euo pipefail
revision="$1"
release="/opt/nexus/releases/$revision"
# Restarting the manager mid-turn drops that turn's reply: wait until no Agent
# run is queued or running (at most 20 minutes, NEXUS_FORCE_ACTIVATE=1 skips).
busy() {
  (cd /opt/nexus/current/packages/runtime-manager && PATH=/root/.nvm/versions/node/v22.22.1/bin:$PATH node -e '
    const pg = require("pg"), c = require("/opt/nexus/data/config.json");
    const p = new pg.Pool({ connectionString: c.databaseUrl });
    p.query("SELECT count(*)::int AS n FROM elastic_runs WHERE status IN (\x27queued\x27, \x27running\x27)")
      .then(r => { console.log(r.rows[0].n); return p.end(); })')
}
if [[ "${FORCE:-}" != 1 && -d /opt/nexus/current ]]; then
  for wait in {1..80}; do
    n="$(busy 2>/dev/null || echo 0)"
    [[ "$n" == 0 ]] && break
    [[ "$wait" == 80 ]] && { echo "$n Agent run(s) still active after 20 min; retry later" >&2; exit 1; }
    echo "waiting for $n active Agent run(s)"; sleep 15
  done
fi
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
    # Keep current, previous and the four newest other releases; a full disk
    # once took PostgreSQL down.
    keep="$(readlink -f /opt/nexus/current) $(readlink -f /opt/nexus/previous 2>/dev/null || true)"
    ls -1dt /opt/nexus/releases/*/ | sed 's#/$##' | while read -r dir; do
      case " $keep " in *" $dir "*) continue ;; esac
      kept=$((${kept:-0} + 1)); [[ "$kept" -le 4 ]] && continue
      rm -rf "$dir" && echo "pruned $(basename "$dir")"
    done
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
  stage-local) stage_local ;;
  activate) activate ;;
  deploy) stage; activate ;;
  *) echo "Usage: $0 [stage|stage-local|activate|deploy] [commit-sha]" >&2; exit 2 ;;
esac
