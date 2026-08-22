# NOTE: CI (Jenkins) builds this package with the CI Dockerfile from the aochi
# repo (cicd/dealclaw-nexus/build/admin-web/Dockerfile), which overrides this
# file at build time. This in-repo Dockerfile is kept for local/manual builds.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
# base=/admin2/ means index.html expects assets under /admin2/*, so the dist
# output must live in the admin2/ subdirectory of the nginx root.
COPY --from=build /app/dist /usr/share/nginx/html/admin2
EXPOSE 8080
