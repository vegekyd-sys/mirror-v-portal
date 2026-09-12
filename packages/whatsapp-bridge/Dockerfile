# whatsapp-bridge CI image. Prisma schema is copied before dependency install
# because both the build and the runtime database initializer require it.
FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
# schema 要先就位：build 脚本是 prisma generate && tsc，生成的类型 tsc 要用
COPY prisma ./prisma
RUN npm install
COPY src ./src
RUN npm run build

FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm
ENV NODE_ENV=production \
    TZ=Asia/Shanghai
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
# 运行层自己再 generate 一次，而不是从构建层拷生成物 —— Prisma 6 的输出位置
# 随包管理器而变（pnpm 下在虚拟 store 里，npm 下在 node_modules/.prisma），
# 跨阶段拷路径不稳。generate 不连数据库，只读 schema，很快。
# prisma CLI 放在 dependencies 里就是为了这里和 initContainer 的 migrate deploy。
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist

# APP_ENV 必须显式给：loadEnv.ts 靠 npm_lifecycle_event 猜环境，
# 而容器里跑的是 node dist/index.js，没有这个变量，会默认成 development。
# 容器里也没有任何 .env 文件，配置全部来自真实环境变量（ConfigMap/Secret）。
ENV APP_ENV=production \
    PORT=8086 \
    ROUTE_PREFIX=/whatsapp

USER node
EXPOSE 8086
CMD ["node", "dist/index.js"]
