#!/usr/bin/env bash

set -euo pipefail

SSH_TARGET="${EMAIL_WEBHOOK_SSH_TARGET:-root@114.55.150.21}"
REMOTE_ENV_FILE="${EMAIL_WEBHOOK_ENV_FILE:-/etc/email-webhook/email-webhook.env}"

if [[ ! "$SSH_TARGET" =~ ^[A-Za-z0-9_.@:-]+$ ]]; then
    printf 'EMAIL_WEBHOOK_SSH_TARGET 含有不支持的字符。\n' >&2
    exit 2
fi
if [[ ! "$REMOTE_ENV_FILE" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
    printf 'EMAIL_WEBHOOK_ENV_FILE 必须是安全的绝对路径。\n' >&2
    exit 2
fi

usage() {
    cat <<'EOF'
用法：
  scripts/get-bindings-token.sh          输出当前绑定接口令牌
  scripts/get-bindings-token.sh --copy   复制到 macOS 剪贴板，不在终端显示

可选环境变量：
  EMAIL_WEBHOOK_SSH_TARGET  SSH 目标，默认 root@114.55.150.21
  EMAIL_WEBHOOK_ENV_FILE    远程配置文件路径
EOF
}

mode="print"
case "${1:-}" in
    "") ;;
    --copy) mode="copy" ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

token="$({
    ssh \
        -o BatchMode=yes \
        -o ConnectTimeout=10 \
        -- \
        "$SSH_TARGET" \
        "sed -n 's/^ADMIN_TOKEN=//p' '$REMOTE_ENV_FILE'"
} | tr -d '\r\n')"

if [[ -z "$token" ]]; then
    printf '未读取到 ADMIN_TOKEN；管理接口可能已关闭或配置文件不存在。\n' >&2
    exit 1
fi

if [[ "$mode" == "copy" ]]; then
    if ! command -v pbcopy >/dev/null 2>&1; then
        printf '当前系统没有 pbcopy，请直接运行脚本输出令牌。\n' >&2
        exit 1
    fi
    printf '%s' "$token" | pbcopy
    printf '绑定接口令牌已复制到剪贴板。\n' >&2
else
    printf '%s\n' "$token"
fi
