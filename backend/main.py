"""Autograde 后端入口：FastAPI + SQLAlchemy 2.0 + SQLite（aiosqlite）。"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from database import init_db
from routers import assignments, classes, health

load_dotenv()

ACCESS_TOKEN = os.getenv("ACCESS_TOKEN", "").strip()

API_PREFIX = "/api/"
PUBLIC_PATHS = {"/api/health"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Autograde", version="0.0.1", lifespan=lifespan)

# Vite 开发端口
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def access_token_guard(request: Request, call_next):
    """访问口令：设置 ACCESS_TOKEN 后，除 /api/health 外所有 /api/* 需 Bearer 认证。"""
    if (
        ACCESS_TOKEN
        and request.url.path.startswith(API_PREFIX)
        and request.url.path not in PUBLIC_PATHS
    ):
        if request.headers.get("authorization", "") != f"Bearer {ACCESS_TOKEN}":
            return JSONResponse(status_code=401, content={"detail": "未授权访问"})
    return await call_next(request)


app.include_router(health.router)
app.include_router(classes.router)
app.include_router(assignments.router)
