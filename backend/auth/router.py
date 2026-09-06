"""Auth 路由 — /api/auth/*（自 Stellaris 移植，注册流程改为邀请码制）。

- 验证码登录为主通道，密码登录为辅
- 注册：邮箱验证码 + 邀请码；系统零用户时免邀请码且首用户自动 is_admin=True
- 防 UID/邮箱枚举：不存在与已发送的响应逐字段一致、统一失败文案、IP 限流先于查库
"""

import asyncio
import logging
import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from auth.captcha import verify_captcha
from auth.dependencies import get_current_user
from auth.email import send_verification_code
from auth.models import InviteCode, User, VerificationCode
from auth.schemas import (
    ChangePasswordRequest,
    CheckEmailRequest,
    CheckEmailResponse,
    LoginCodeRequest,
    LoginCodeResponse,
    LoginPasswordRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SendCodeRequest,
    SendCodeResponse,
    UpdateProfileRequest,
    UserPublic,
)
from auth.utils import (
    check_email_cooldown,
    check_email_probe_rate,
    check_login_rate,
    check_send_code_rate,
    create_access_token,
    generate_code,
    get_client_ip,
    get_next_uid,
    hash_password,
    validate_password_strength,
    verify_password,
)
from database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

CODE_EXPIRE_MINUTES = 5
CODE_MAX_ATTEMPTS = 5


def _user_to_public(user: User) -> UserPublic:
    """ORM User → 对外 UserPublic（脱去密码哈希等敏感字段）。"""
    return UserPublic(
        uid=user.uid,
        email=user.email,
        nickname=user.nickname,
        avatar_seed=user.avatar_seed,
        bio=user.bio,
        is_admin=user.is_admin,
    )


def _is_expired(expires_at: datetime) -> bool:
    """验证码过期判断（兼容 naive/aware datetime）。"""
    now = datetime.now(timezone.utc)
    exp = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    return now > exp


async def _user_count(db: AsyncSession) -> int:
    return (
        await db.execute(select(func.count(User.id)))
    ).scalar_one()


def _resolve_identity(raw: str) -> tuple[str, str]:
    """身份解析（send-code/login-code/reset-password/login-password 共用）。
    返回 ("email", 规范化邮箱) 或 ("uid", 归一化 UID 字符串)。"""
    from email_validator import EmailNotValidError, validate_email as _ev

    s = raw or ""
    if "@" in s:
        try:
            return "email", _ev(s, check_deliverability=False).normalized
        except EmailNotValidError:
            raise HTTPException(status_code=422, detail="邮箱格式不正确")
    if re.fullmatch(r"[0-9]{1,18}", s):
        return "uid", str(int(s))
    raise HTTPException(status_code=422, detail="请输入正确的邮箱地址或 UID")


# ===== 邮箱验证码登录环路 =====


@router.post("/check-email", response_model=CheckEmailResponse)
async def check_email(
    req: CheckEmailRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """检查邮箱是否已注册；need_invite 告知前端注册是否需要邀请码。IP 限流先于查库。"""
    if not check_email_probe_rate(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    result = await db.execute(select(User.uid).where(User.email == req.email))
    exists = result.scalar_one_or_none() is not None
    need_invite = await _user_count(db) > 0
    return CheckEmailResponse(exists=exists, need_invite=need_invite)


@router.post("/send-code", response_model=SendCodeResponse)
async def send_code(
    req: SendCodeRequest,
    request: Request,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """发送验证码：图形验证码 → 限流 → 生码 → upsert → 后台发邮件。

    防 UID 枚举：UID 不存在时响应与「已发送」逐字段一致、不真发；
    邮件统一后台发送——失败只记日志，存在/不存在 UID 的响应与时序无差别。"""
    client_ip = get_client_ip(request)

    # 图形验证码：remote_ip 传 socket peer（不可伪造）；限流才用 XFF 推导值
    if not await verify_captcha(
        req.captcha_id, req.captcha_answer, request.client.host if request.client else None
    ):
        raise HTTPException(status_code=403, detail="人机验证失败，请重试")
    if not check_send_code_rate(client_ip):
        raise HTTPException(status_code=429, detail="发送过于频繁，请 1 分钟后再试")

    kind, value = _resolve_identity(req.email)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
        u = result.scalar_one_or_none()
        if not u:
            return SendCodeResponse()  # 防 UID 枚举：响应逐字段一致，不真发
        email = u.email
    else:
        email = value

    # 单邮箱冷却：同一邮箱 60 秒内只发一次（在身份解析之后，不存在的 UID 到不了这里）
    if not check_email_cooldown(email):
        raise HTTPException(status_code=429, detail="发送过于频繁，请 1 分钟后再试")

    code = generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=CODE_EXPIRE_MINUTES)

    record = await db.get(VerificationCode, email)
    if record:
        record.code = code
        record.expires_at = expires_at
        record.attempts = 0
    else:
        db.add(VerificationCode(email=email, code=code, expires_at=expires_at, attempts=0))
    await db.commit()

    background.add_task(_send_code_safe, email, code)
    return SendCodeResponse()


async def _send_code_safe(email: str, code: str) -> None:
    """后台发验证码：失败只记日志（响应侧无差别，防枚举；诊断可追）。"""
    try:
        await send_verification_code(email, code)
    except Exception as e:
        logger.error("验证码发送失败: %s", str(e)[:200])


@router.post("/login-code", response_model=LoginCodeResponse)
async def login_code(
    req: LoginCodeRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """验证码登录：老用户发 JWT，新用户返回 need_register。

    IP 级限流先于查库（存在/不存在到达阈值同样 429）；
    不存在/未发码/过期/错误统一文案「验证码错误或已过期」。"""
    if not check_login_rate(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="尝试过于频繁，请稍后再试")
    kind, value = _resolve_identity(req.email)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
        u = result.scalar_one_or_none()
        if not u:
            raise HTTPException(status_code=400, detail="验证码错误或已过期")
        email = u.email
    else:
        email = value
    record = await db.get(VerificationCode, email)
    if not record:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    if _is_expired(record.expires_at):
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    if record.attempts >= CODE_MAX_ATTEMPTS:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    if record.code != req.code:
        record.attempts += 1
        await db.commit()
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    user_result = await db.execute(select(User).where(User.email == email))
    user = user_result.scalar_one_or_none()

    if user:
        # 老用户：发 JWT，删除验证码
        await db.delete(record)
        await db.commit()
        token = create_access_token(user.uid, user.email)
        return LoginCodeResponse(token=token, user=_user_to_public(user))
    # 新用户：不删码（register 时还要再验一次）
    return LoginCodeResponse(need_register=True)


# ===== 注册 / 密码登录 / 资料 =====


def _invite_is_valid(invite: InviteCode | None) -> bool:
    if invite is None or invite.revoked:
        return False
    if invite.use_count >= invite.max_uses:
        return False
    if invite.expires_at is not None:
        exp = (
            invite.expires_at
            if invite.expires_at.tzinfo
            else invite.expires_at.replace(tzinfo=timezone.utc)
        )
        if datetime.now(timezone.utc) > exp:
            return False
    return True


@router.post("/register", response_model=LoginCodeResponse, status_code=201)
async def register(req: RegisterRequest, db: AsyncSession = Depends(get_db)):
    """注册新用户：再验码 → 邀请码 → 密码强度 → 建用户 → 销码 → 发 JWT。

    邀请码规则：系统零用户时免邀请码且首用户自动 is_admin=True（部署引导）；
    之后必须持未用/未过期/未作废的邀请码注册，注册成功即消耗一次。
    邮箱先经 _resolve_identity 归一化（消灭大写邮箱死锁与同邮箱双账号）。"""
    kind, email = _resolve_identity(req.email)
    if kind != "email":
        raise HTTPException(status_code=422, detail="注册请使用邮箱地址")

    # ① 再验验证码（新用户 login-code 没删码，这里二次校验）
    record = await db.get(VerificationCode, email)
    if not record or _is_expired(record.expires_at) or record.code != req.code:
        raise HTTPException(status_code=400, detail="验证码无效或已过期，请重新发送")
    if record.attempts >= CODE_MAX_ATTEMPTS:
        raise HTTPException(status_code=429, detail="尝试次数过多，请重新发送验证码")

    # ② 邀请码：零用户免码即管理员；之后必须有效邀请码
    first_user = (await _user_count(db)) == 0
    invite: InviteCode | None = None
    if first_user:
        is_admin = True
    else:
        is_admin = False
        if not req.invite_code or not req.invite_code.strip():
            raise HTTPException(status_code=403, detail="注册需要邀请码")
        result = await db.execute(
            select(InviteCode).where(InviteCode.code == req.invite_code.strip().upper())
        )
        invite = result.scalar_one_or_none()
        if not _invite_is_valid(invite):
            raise HTTPException(status_code=403, detail="邀请码无效或已过期")

    # ③ 密码强度（schema 已校验 min 8，这里补字母+数字+符号）
    pwd_errors = validate_password_strength(req.password)
    if pwd_errors:
        raise HTTPException(status_code=422, detail="; ".join(pwd_errors))

    # ④ 邮箱查重（归一化后的值；UNIQUE 约束兜底竞态）
    existing = await db.execute(select(User.uid).where(User.email == email))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录")

    # ⑤ 建用户（hash 放线程池，不阻塞事件循环）
    uid = await get_next_uid(db)
    password_hash = await asyncio.to_thread(hash_password, req.password)
    user = User(
        uid=uid,
        email=email,
        nickname=req.nickname,
        avatar_seed=req.avatar_seed,
        password_hash=password_hash,
        is_admin=is_admin,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="注册失败（账号冲突），请重试")
    await db.refresh(user)

    # ⑥ 消耗邀请码 + 删码 + 发 JWT
    if invite is not None:
        invite.use_count += 1
        invite.used_by = user.uid
        invite.used_at = datetime.now(timezone.utc)
    await db.delete(record)
    await db.commit()
    token = create_access_token(user.uid, user.email)
    return LoginCodeResponse(token=token, user=_user_to_public(user))


@router.post("/login-password", response_model=LoginCodeResponse)
async def login_password(
    req: LoginPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """密码登录：支持邮箱或 UID（纯数字按 UID 查）。"""
    if not await verify_captcha(
        req.captcha_id, req.captcha_answer, request.client.host if request.client else None
    ):
        raise HTTPException(status_code=403, detail="人机验证失败，请重试")
    ip = get_client_ip(request)
    if not check_login_rate(ip):
        raise HTTPException(status_code=429, detail="登录尝试过于频繁，请稍后再试")
    kind, value = _resolve_identity(req.email_or_uid)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
    else:
        result = await db.execute(select(User).where(User.email == value))
    user = result.scalar_one_or_none()

    if not user or not user.password_hash:
        raise HTTPException(status_code=401, detail="账号或密码错误")

    # verify 放线程池（CPU 密集）
    ok = await asyncio.to_thread(verify_password, req.password, user.password_hash)
    if not ok:
        # 账号不存在与密码错误统一文案（防账号枚举）
        raise HTTPException(status_code=401, detail="账号或密码错误")

    token = create_access_token(user.uid, user.email)
    return LoginCodeResponse(token=token, user=_user_to_public(user))


@router.get("/me", response_model=UserPublic)
async def get_me(current_user: User = Depends(get_current_user)):
    """返回当前登录用户（前端刷新验 token）。"""
    return _user_to_public(current_user)


@router.put("/profile", response_model=UserPublic)
async def update_profile(
    req: UpdateProfileRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """更新昵称/头像/签名（部分更新；改密走 change-password/reset-password）。"""
    if req.nickname is not None:
        current_user.nickname = req.nickname
    if req.avatar_seed is not None:
        current_user.avatar_seed = req.avatar_seed
    if req.bio is not None:
        current_user.bio = req.bio
    await db.commit()
    await db.refresh(current_user)
    return _user_to_public(current_user)


@router.put("/change-password")
async def change_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """修改密码（需登录，旧密码通道）：验旧密码 → 强度校验 → 更新哈希。"""
    if not current_user.password_hash:
        raise HTTPException(status_code=400, detail="该账号未设置密码，请用验证码重置")
    ok = await asyncio.to_thread(verify_password, req.old_password, current_user.password_hash)
    if not ok:
        # 旧密码错误是表单校验失败，不是会话失效——用 400（401 会触发前端全局登出）
        raise HTTPException(status_code=400, detail="旧密码错误")

    pwd_errors = validate_password_strength(req.new_password)
    if pwd_errors:
        raise HTTPException(status_code=422, detail="; ".join(pwd_errors))

    current_user.password_hash = await asyncio.to_thread(hash_password, req.new_password)
    await db.commit()
    return {"ok": True}


@router.post("/reset-password")
async def reset_password(
    req: ResetPasswordRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """忘记密码（免登录，验证码通道）：验码 → 强度校验 → 更新哈希 → 销码。"""
    if not check_login_rate(get_client_ip(request)):
        raise HTTPException(status_code=429, detail="尝试过于频繁，请稍后再试")
    kind, value = _resolve_identity(req.email)
    if kind == "uid":
        result = await db.execute(select(User).where(User.uid == int(value)))
        u = result.scalar_one_or_none()
        if not u:
            raise HTTPException(status_code=400, detail="验证码错误或已过期")
        email = u.email
    else:
        email = value
    record = await db.get(VerificationCode, email)
    if not record or _is_expired(record.expires_at) or record.code != req.code:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")
    if record.attempts >= CODE_MAX_ATTEMPTS:
        raise HTTPException(status_code=400, detail="验证码错误或已过期")

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="该邮箱尚未注册")

    pwd_errors = validate_password_strength(req.new_password)
    if pwd_errors:
        raise HTTPException(status_code=422, detail="; ".join(pwd_errors))

    user.password_hash = await asyncio.to_thread(hash_password, req.new_password)
    await db.delete(record)
    await db.commit()
    return {"ok": True}
