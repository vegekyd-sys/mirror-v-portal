FROM dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com/dealclaw-nexus/node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM docker.m.daocloud.io/library/nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
# base='/' — dist goes straight into the nginx html root.
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
