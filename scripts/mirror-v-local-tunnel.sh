#!/usr/bin/env bash
set -euo pipefail

# Access the deployed Mirror V portal from this Mac through SSH. This serves
# the production instance at a loopback URL; it does not run a local copy.
port="${NEXUS_LOCAL_PORT:-18080}"
target="${NEXUS_MIRROR_SSH_TARGET:-root@43.134.135.143}"
key="${NEXUS_MIRROR_SSH_KEY:-$HOME/.ssh/nexus-mirror-v-deploy-20260925}"
echo "Nexus portal: http://127.0.0.1:$port/onboard"
echo "Admin console: http://127.0.0.1:$port/admin/login"
exec ssh -N -L "127.0.0.1:$port:127.0.0.1:80" -i "$key" \
  -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "$target"
