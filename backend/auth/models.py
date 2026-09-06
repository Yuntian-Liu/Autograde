"""ORM 模型 — users / verification_codes / invite_codes（自 Stellaris 移植裁剪）。

- User 去掉 Stellaris 的 vault / admin_pin / badge 等专有字段，保留账号体系核心
- InviteCode 在 Stellaris 是占位表，Autograde 做实：邀请码制注册 + 管理后台接口
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    uid: Mapped[int] = mapped_column(Integer, unique=True, index=True, nullable=False)  # 业务号，从 100000 递增
    email: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)
    nickname: Mapped[str] = mapped_column(String, nullable=False)
    avatar_seed: Mapped[str] = mapped_column(String, nullable=False)  # DiceBear 头像种子
    bio: Mapped[str | None] = mapped_column(String, default="")
    # bcrypt 自带 salt，单字段足够；纯验证码登录用户可为 NULL
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class VerificationCode(Base):
    __tablename__ = "verification_codes"

    # email 作主键：同一邮箱同时只存一条（UPSERT 覆盖）
    email: Mapped[str] = mapped_column(String, primary_key=True)
    code: Mapped[str] = mapped_column(String, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0)  # 错 5 次销码
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class InviteCode(Base):
    """邀请码：碳碳在管理后台生成发放，同事凭码注册。软作废（revoked）保留历史。"""

    __tablename__ = "invite_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    code: Mapped[str] = mapped_column(String, unique=True, index=True, nullable=False)  # 形如 AG-1A2B3C4D
    created_by: Mapped[int] = mapped_column(Integer, nullable=False)  # 生成者 uid
    used_by: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 最近一次使用者 uid
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # 空 = 永不过期
    max_uses: Mapped[int] = mapped_column(Integer, default=1)  # 可用次数（1 = 一次性）
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String, default="")  # 备注（给谁发的等）
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
