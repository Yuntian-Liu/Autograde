# Autograde 单服务镜像：前端 vite build + 后端 uvicorn（Zeabur 部署用）
# SQLite 数据放 /app/data（Zeabur 卷挂载点）

# ---- 阶段 1：构建前端 ----
FROM node:20-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- 阶段 2：运行时 ----
FROM python:3.12-slim
WORKDIR /app

# 系统依赖：captcha 字体渲染（Pillow）
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=frontend /build/dist ./frontend/dist

# 数据目录（卷挂载点）
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/autograde.db

# 前端产物目录（容器内布局为 /app/main.py + /app/frontend/dist，与本地不同，必须显式指定）
ENV FRONTEND_DIST=/app/frontend/dist

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
