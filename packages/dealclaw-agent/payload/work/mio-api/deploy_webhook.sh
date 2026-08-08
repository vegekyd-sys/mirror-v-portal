#!/bin/bash
# DC Webhook Handler 部署脚本
# 在 114.55.150.21 上执行

# 1. 安装依赖
pip3 install flask

# 2. 设置环境变量
export RESEND_API_KEY="re_RiTH56eY_AYyxnPLDb6Nv3MttXKprXDAZ"

# 3. 复制 dc_webhook_handler.py 到服务器
#    从这个服务器 scp 过去，或者直接 vim 粘贴

# 4. 启动 (替换原有的 8080 端口服务)
python3 dc_webhook_handler.py --port 8080 &

echo "Webhook handler started on :8080"
echo "Test: curl -X POST http://localhost:8080/health"
