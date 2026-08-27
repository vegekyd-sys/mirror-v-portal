#!/usr/bin/env bash
#
# 生成一个新的管理接口令牌（ADMIN_TOKEN）。
#
# 这段逻辑原先在部署脚本 deploy/bootstrap.sh 里，首次部署时自动跑一次。
# 迁到 k8s 之后没有 bootstrap 了，令牌的生成和轮换都变成手动操作，所以单独成脚本。
#
# 只负责生成并输出，不会去改任何 Secret 或 env —— 应用步骤见输出末尾的提示。

set -euo pipefail

usage() {
    cat <<'EOF'
用法：
  scripts/new-admin-token.sh           生成并打印一个新令牌 + 后续步骤
  scripts/new-admin-token.sh --copy    复制到 macOS 剪贴板，不在终端显示
  scripts/new-admin-token.sh --quiet   只输出令牌本身，便于管道使用

令牌规格：24 字节 /dev/urandom → base64 → 去掉 / + = ，得到 31–32 位纯字母数字。
熵约 192 bit，剥离字符只影响编码不减熵。
EOF
}

mode="verbose"
case "${1:-}" in
    "") ;;
    --copy) mode="copy" ;;
    --quiet|-q) mode="quiet" ;;
    -h|--help)
        usage
        exit 0
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac

token="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"

if [[ -z "$token" ]]; then
    printf '生成失败：没有从 /dev/urandom 读到数据。\n' >&2
    exit 1
fi

case "$mode" in
    copy)
        if ! command -v pbcopy >/dev/null 2>&1; then
            printf '当前系统没有 pbcopy，请用 --quiet 直接输出。\n' >&2
            exit 1
        fi
        printf '%s' "$token" | pbcopy
        printf '新的 ADMIN_TOKEN 已复制到剪贴板（未在终端显示）。\n' >&2
        ;;
    quiet)
        printf '%s\n' "$token"
        ;;
    *)
        printf '%s\n\n' "$token"
        cat <<'EOF'
应用到集群（替换 <namespace>，令牌用上面那个值）：

  kubectl -n <namespace> patch secret email-webhook-secret \
    -p "{\"stringData\":{\"ADMIN_TOKEN\":\"<新令牌>\"}}"

  kubectl -n <namespace> rollout restart deploy/email-webhook

改完 Secret 必须 rollout restart —— envFrom 不会自动触发滚动。

⚠️ 轮换是有调用方的：openclaw（调 /bindings、/suppliers）和本地 poller
（调 /v1/events）都配了这个值，要同步更新，否则它们会开始收到 401。
轮换本身不影响任何已有绑定数据。
EOF
        ;;
esac
