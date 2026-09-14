# 本地页面结构预览

启动：

```sh
VITE_LOCAL_PREVIEW=1 pnpm --filter admin-web dev --host 127.0.0.1 --port 8099 --strictPort
```

打开 http://127.0.0.1:8099/ ，无需管理员令牌。沿用原后台页面；客户、余额、套餐、定价均为虚构示例，其余部分为空状态。预览模式不执行写操作，不调用线上 API，不代表新 Sandbox 已接入原计费系统。

只有 Vite 开发模式 + 显式环境变量 + localhost 同时满足才启用。正常生产构建保留原登录和 API 行为。
