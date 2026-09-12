# email-webhook CI image. Integration tests require PostgreSQL and run outside
# the image build; this stage performs the production TypeScript build.
FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# 运行期默认值。其余配置由 ConfigMap/Secret 注入，见 k8s/base/email-webhook/。
# HOST 必须是 0.0.0.0：默认 127.0.0.1 的话探针和 Service 都连不进来。
# 状态全在 PostgreSQL 里（DATABASE_URL 由 Secret 注入），容器不写盘。
ENV HOST=0.0.0.0 \
    PORT=8000 \
    ROUTE_PREFIX=/webhook

USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
