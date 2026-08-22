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
# base='/' — dist goes straight into the nginx html root.
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
