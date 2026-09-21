"""Autograde 后端入口：FastAPI + SQLAlchemy 2.0 + SQLite（aiosqlite）。

鉴权：JWT（auth 子包，路由级 Depends 注入，无全局中间件）；
/api/health、/api/auth/*、/api/captcha 为公开路径，其余全部需要 Bearer token。
单服务部署：生产环境托管 frontend/dist 静态文件 + SPA fallback。
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

import anyio
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import config
from auth.captcha import new_captcha
from auth.dependencies import get_current_user
from auth.router import router as auth_router
from auth.utils import check_captcha_rate, get_client_ip
from database import get_db, init_db
from diagnostics import APP_VERSION, attach_log_buffer, build_diagnostics
from routers import admin, ai, assignments, classes, client_log, health, notes, phrases, questions, students

load_dotenv()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    attach_log_buffer()  # 服务端日志环形缓冲（诊断导出用）
    logging.getLogger("autograde").warning("启动完成 version=%s", APP_VERSION)
    # 每日自动备份（仅生产；本地开发不打扰）：最新备份超 24h 即补一份
    if config.IS_PROD:
        from backup import maybe_daily_backup

        asyncio.create_task(maybe_daily_backup())
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


app = FastAPI(title="Autograde", version="0.12.2", lifespan=lifespan)

# GZip：JS/CSS/JSON 压缩传输（1.8MB bundle → 约 450KB）
from fastapi.middleware.gzip import GZipMiddleware

app.add_middleware(GZipMiddleware, minimum_size=1000)


# 可观测性：5xx（含未捕获异常，带堆栈）与慢请求（>3s）进服务端日志环形缓冲，诊断导出可见
@app.middleware("http")
async def access_observability(request: Request, call_next):
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except anyio.EndOfStream:
        # 客户端中途断连（页面关闭瞬间的 keepalive 上报等）：正常噪音，不进错误日志
        return Response(status_code=499)
    except Exception:
        logging.getLogger("autograde.http").exception(
            "未捕获异常 %s %s", request.method, request.url.path
        )
        raise
    elapsed_ms = (time.perf_counter() - started) * 1000
    if response.status_code >= 500:
        logging.getLogger("autograde.http").error(
            "5xx %s %s → %s（%.0fms）",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
    elif elapsed_ms > 3000:
        logging.getLogger("autograde.http").warning(
            "慢请求 %s %s → %s（%.0fms）",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
    return response


# 静态资源缓存头（照 Gradify 旧版策略）：
# /assets/* 与 favicon 文件名带哈希 → immutable 永久缓存（发新版=新文件名，不会拿错）；
# 其余非 /api 路径（首页 + 所有 SPA 路由都回落 index.html）→ 一律 no-cache，保证发版即更新
@app.middleware("http")
async def cache_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/") or path == "/favicon.svg":
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif not path.startswith("/api"):
        response.headers["Cache-Control"] = "no-cache"
    return response


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
app.include_router(notes.router)
app.include_router(client_log.router)


# ---- 图形验证码（公开；生成接口限流防刷）----
@app.get("/api/captcha")
async def captcha(request: Request):
    if not check_captcha_rate(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    return new_captcha()


# ---- 公开配置（前端判断 dev/prod 与验证码通道：dev 不渲染图形验证码）----
@app.get("/api/config")
async def public_config() -> dict:
    return {
        "is_prod": config.IS_PROD,
        "captcha": "aliyun" if config.ALIYUN_CAPTCHA_PREFIX else "self",
    }


# ---- 诊断日志导出（登录即可；前端注入浏览器端事件后整包下载）----
@app.get("/api/diagnostics/export")
async def export_diagnostics(db=Depends(get_db), user=Depends(get_current_user)) -> dict:
    return await build_diagnostics(db, user)


# ---- 评级分数线（登录即可读；批改页实时预览用）----
@app.get("/api/rating-thresholds")
async def rating_thresholds(db=Depends(get_db), user=Depends(get_current_user)) -> list:
    from rating import get_thresholds

    return [{"rating": r, "min": m} for r, m in await get_thresholds(db)]


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
