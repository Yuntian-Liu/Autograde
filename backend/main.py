"""Autograde 后端入口：FastAPI + SQLAlchemy 2.0 + SQLite（aiosqlite）。

鉴权：JWT（auth 子包，路由级 Depends 注入，无全局中间件）；
/api/health、/api/auth/*、/api/captcha 为公开路径，其余全部需要 Bearer token。
单服务部署：生产环境托管 frontend/dist 静态文件 + SPA fallback。
"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config
from auth.captcha import new_captcha
from auth.dependencies import get_current_user
from auth.router import router as auth_router
from auth.utils import check_captcha_rate, get_client_ip
from database import get_db, init_db
from diagnostics import attach_log_buffer, build_diagnostics
from routers import admin, ai, assignments, classes, health, phrases, questions, students

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    attach_log_buffer()  # 服务端日志环形缓冲（诊断导出用）
    # 生产环境关键配置缺失时启动即警告（不阻断——降级运行便于排查）
    if config.IS_PROD:
        if config.JWT_SECRET == "dev-secret-change-me":
            print(
                "[WARN] 生产环境未配置 JWT_SECRET，正在使用不安全的默认值！"
                "请用 python3 -c 'import secrets; print(secrets.token_urlsafe(48))' 生成后填入环境变量"
            )
        if not config.RESEND_API_KEY or not config.RESEND_FROM:
            print("[WARN] 生产环境未配置 RESEND_API_KEY / RESEND_FROM，验证码邮件将发送失败")
    yield


app = FastAPI(title="Autograde", version="0.2.0", lifespan=lifespan)

# Vite 开发端口（生产同源部署不走 CORS）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- 业务与认证路由 ----
app.include_router(health.router)
app.include_router(auth_router)
app.include_router(admin.router)
app.include_router(classes.router)
app.include_router(students.router)
app.include_router(assignments.router)
app.include_router(questions.router)
app.include_router(ai.router)
app.include_router(phrases.router)


# ---- 图形验证码（公开；生成接口限流防刷）----
@app.get("/api/captcha")
async def captcha(request: Request):
    if not check_captcha_rate(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    return new_captcha()


# ---- 公开配置（前端判断 dev/prod：dev 不渲染图形验证码）----
@app.get("/api/config")
async def public_config() -> dict:
    return {"is_prod": config.IS_PROD}


# ---- 诊断日志导出（登录即可；前端注入浏览器端事件后整包下载）----
@app.get("/api/diagnostics/export")
async def export_diagnostics(db=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return await build_diagnostics(db, user)


# ---- 单服务部署：托管前端静态文件（FRONTEND_DIST 指向 vite build 产物目录）----
DIST = config.FRONTEND_DIST or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "dist"
)
if os.path.isdir(DIST):
    app.mount("/assets", StaticFiles(directory=os.path.join(DIST, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPA fallback：非 /api 路径回 index.html（前端路由接管）。

        路径穿越防护：realpath 净化后必须仍落在 dist 目录内才返回文件，
        否则一律回落 index.html（/%2e%2e%2fbackend%2f.env 之类不可读）。"""
        if full_path.startswith("api"):
            raise HTTPException(status_code=404, detail="Not Found")
        dist_root = os.path.realpath(DIST)
        candidate = os.path.realpath(os.path.join(dist_root, full_path))
        if (
            full_path
            and candidate.startswith(dist_root + os.sep)
            and os.path.isfile(candidate)
        ):
            return FileResponse(candidate)
        return FileResponse(os.path.join(dist_root, "index.html"))
