FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm AS build
WORKDIR /app
COPY package*.json .
RUN npm install
COPY . .
RUN npm test
RUN npm run build

FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8085
CMD ["node", "dist/index.js"]
