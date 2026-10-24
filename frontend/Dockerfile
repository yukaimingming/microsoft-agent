# 阶段 1：构建前端
FROM node:22-alpine AS builder

WORKDIR /app

# 启用 corepack 并配置 pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# 拷贝依赖配置
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* ./
COPY frontend ./frontend

# 安装依赖并构建
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @deepagent/web build

# 阶段 2：运行 Nginx 镜像
FROM nginx:alpine

# 拷贝前端构建产物
COPY --from=builder /app/frontend/apps/web/dist /usr/share/nginx/html

# 拷贝 Nginx 配置
COPY nginx/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
