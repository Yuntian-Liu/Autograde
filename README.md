# Autograde

英语助教的个人批改工作台：班级 → 作业批次 → 题库 → 学生错题勾选 → 自动拼装反馈文本。

- 前端：React 18 + Vite + AntD 5（设计令牌见 `design/tokens.css`，1:1 映射主题）
- 后端：FastAPI + SQLAlchemy 2.0 + SQLite（aiosqlite），启动自愈建表/补列
- 单一事实来源：`DEVELOPMENT.md`

## 快速开始

### 后端（端口 8000）

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python seed.py                      # 写入演示数据（--fresh 可重建）
uvicorn main:app --port 8000
```

验证：`curl localhost:8000/api/health`

访问口令（可选）：复制 `.env.example` 为 `.env` 并设置 `ACCESS_TOKEN`，此后除 `/api/health` 外所有 `/api/*` 需 `Authorization: Bearer <token>`。

### 前端（端口 5173）

```bash
cd frontend
npm install
npm run dev
```

开发服务器已将 `/api` 代理到 `localhost:8000`，打开 http://localhost:5173 即可。

## 页面

- `/` 工作台（待办 / 班级 / 最近批次）
- `/classes/:id` 班级页（学生名单 + 批次列表）
- `/assignments/:id` 批次页（提交状态 + 题库预览 + 进入批改）
- `/grading/:assignmentId` 批改页（三栏工作台：学生名单 / 信息栏 + 错题勾选 / 只读预览）
