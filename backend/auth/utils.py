"""Auth 工具 — JWT、验证码、UID、密码哈希、强度校验、限流（自 Stellaris 移植裁剪）。

限流为进程内存滑动窗口（dict[IP, 时间戳数组]），单实例部署自洽，重启清空。
"""

import hashlib
import re
import secrets
import time
from collections import deque
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.models import User
from config import JWT_ALGORITHM, JWT_EXPIRE_DAYS, JWT_SECRET


# ===== 密码哈希（直接用 bcrypt 库，不用 passlib——passlib 停更且不兼容 bcrypt 5.0）=====
def _prehash(plain: str) -> bytes:
    """sha256 预哈希：避开 bcrypt 72 字节限制，支持任意长度密码。"""
    return hashlib.sha256(plain.encode("utf-8")).hexdigest().encode("utf-8")


def hash_password(plain: str) -> str:
    """哈希密码（CPU 密集，调用方需 asyncio.to_thread 包裹）。bcrypt 自带 salt。"""
    return bcrypt.hashpw(_prehash(plain), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """校验密码（CPU 密集，调用方需 asyncio.to_thread 包裹）。"""
    try:
        return bcrypt.checkpw(_prehash(plain), hashed.encode("utf-8"))
    except Exception:
        return False


# ===== 密码强度校验（≥8 位 + 字母 + 数字 + 符号）=====
_PASSWORD_SYMBOLS = set("!@#$%^&*()-_=+[]{}|;:,.<>?/")


def validate_password_strength(password: str) -> list[str]:
    """返回错误信息列表（空 = 通过）。"""
    errors = []
    if len(password) < 8:
        errors.append("密码至少 8 位")
    if not re.search(r"[A-Za-z]", password):
        errors.append("密码需包含字母")
    if not re.search(r"\d", password):
        errors.append("密码需包含数字")
    if not any(ch in _PASSWORD_SYMBOLS for ch in password):
        errors.append("密码需包含符号(!@#$%^&* 等)")
    return errors


# ===== JWT（HS256，7 天单 token）=====
def create_access_token(uid: int, email: str) -> str:
    """签发 JWT。payload: {uid, email, exp, iat}"""
    now = datetime.now(timezone.utc)
    payload = {
        "uid": uid,
        "email": email,
        "exp": now + timedelta(days=JWT_EXPIRE_DAYS),
        "iat": now,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    """解码 JWT，过期/无效返回 None。"""
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


# ===== 验证码生成 =====
def generate_code() -> str:
    """6 位数字验证码（secrets 安全随机）。"""
    return f"{secrets.randbelow(1000000):06d}"


# ===== UID 生成（从 100000 起）=====
async def get_next_uid(db: AsyncSession) -> int:
    """COALESCE(MAX(uid), 99999) + 1。并发靠 uid UNIQUE 兜底（register 时 IntegrityError 重试）。"""
    result = await db.execute(select(func.coalesce(func.max(User.uid), 99999) + 1))
    return result.scalar_one()


# ===== 客户端 IP（仅限流用——bypass 判定必须用 socket peer）=====
def get_client_ip(request) -> str:
    """Zeabur 等反代把真实客户端 IP 追加为 X-Forwarded-For 的最后一跳；
    首跳可由客户端伪造，故取最后一跳。"""
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _sliding_window(bucket: dict[str, list[float]], ip: str, max_times: int, window_sec: int) -> bool:
    """通用滑窗限流：True 允许，False 超限。进程重启清空。"""
    now = time.time()
    arr = [t for t in bucket.get(ip, []) if now - t < window_sec]
    if len(arr) >= max_times:
        bucket[ip] = arr
        return False
    arr.append(now)
    bucket[ip] = arr
    return True


# send-code：IP 每分钟 3 次（防验证码邮件轰炸）
_send_code_rate: dict[str, list[float]] = {}


def check_send_code_rate(ip: str) -> bool:
    return _sliding_window(_send_code_rate, ip, 3, 60)


# 登录/验证码提交/重置密码共用闸门：IP 每分钟 10 次（防暴力撞）
_login_rate: dict[str, list[float]] = {}

# 安全面板数据：拦截计数 + 最近事件环形缓冲（进程内存，重启清零）
_login_blocked_count: int = 0
_login_blocked_events: deque = deque(maxlen=50)


def check_login_rate(ip: str) -> bool:
    global _login_blocked_count
    ok = _sliding_window(_login_rate, ip, 10, 60)
    if not ok:
        _login_blocked_count += 1
        _login_blocked_events.append(
            {
                "time": time.strftime("%m-%d %H:%M:%S"),
                "ip": ip,
                "type": "login_blocked",
                "detail": f"IP {ip} 登录尝试 10 次/分钟超限被拒",
            }
        )
    return ok


def get_login_blocked_count() -> int:
    return _login_blocked_count


def get_login_blocked_events() -> list:
    return list(reversed(_login_blocked_events))


# 图形验证码生成：IP 每分钟 30 次（防刷图库）
_captcha_rate: dict[str, list[float]] = {}


def check_captcha_rate(ip: str) -> bool:
    return _sliding_window(_captcha_rate, ip, 30, 60)


# check-email：IP 每分钟 10 次（防注册枚举探测）
_check_email_rate: dict[str, list[float]] = {}


def check_email_probe_rate(ip: str) -> bool:
    return _sliding_window(_check_email_rate, ip, 10, 60)


# send-code 单邮箱冷却：同一邮箱 60 秒内只发一次（防邮件轰炸）
_send_code_email: dict[str, list[float]] = {}


def check_email_cooldown(email: str) -> bool:
    return _sliding_window(_send_code_email, email.lower(), 1, 60)


# AI 接口：每用户每分钟 12 次（防恶意刷量，不伤正常批改）
_ai_rate: dict[str, list[float]] = {}


def check_ai_rate(uid: int) -> bool:
    return _sliding_window(_ai_rate, f"u{uid}", 12, 60)


# ===== 邀请码生成（AG- + 8 位大写 hex，约 43 亿组合）=====
def generate_invite_code() -> str:
    return f"AG-{secrets.token_hex(4).upper()}"
