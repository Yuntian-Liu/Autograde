"""Auth 依赖注入 — get_current_user / get_admin_user（自 Stellaris 移植）。"""

from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from auth.models import User
from auth.utils import decode_access_token
from database import get_db


async def get_current_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """从 Authorization: Bearer <token> 解当前用户。失败抛 401。"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录")
    payload = decode_access_token(authorization[7:])
    if not payload:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    uid = payload.get("uid")
    if uid is None:
        raise HTTPException(status_code=401, detail="登录凭证无效")
    # JWT 存的是业务 uid（不是主键 id），按 uid 查
    result = await db.execute(select(User).where(User.uid == uid))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


async def get_admin_user(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """admin 守卫：未登录/凭证无效 401，已登录但非 is_admin 403。"""
    user = await get_current_user(authorization, db)
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="无权限")
    return user
