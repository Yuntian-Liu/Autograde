"""Auth 请求/响应 Pydantic 模型（自 Stellaris 移植）。"""

from pydantic import BaseModel, EmailStr, Field


class UserPublic(BaseModel):
    """对外暴露的用户信息（不含密码哈希）"""

    uid: int
    email: str
    nickname: str
    avatar_seed: str
    bio: str | None = None
    is_admin: bool = False


class CheckEmailRequest(BaseModel):
    email: EmailStr


class CheckEmailResponse(BaseModel):
    exists: bool
    need_invite: bool = False  # 已有用户时注册需邀请码，前端据此显示邀请码输入框


class SendCodeRequest(BaseModel):
    # 邮箱或 UID（后端分流：含 @ 按邮箱，纯数字按 UID 查绑定邮箱）
    email: str = Field(..., min_length=1, max_length=128)
    # 图形验证码（生产必填，dev bypass 可空）
    captcha_id: str | None = Field(None, max_length=64)
    captcha_answer: str | None = Field(None, max_length=16)


class SendCodeResponse(BaseModel):
    ok: bool = True
    message: str = "验证码已发送"


class LoginCodeRequest(BaseModel):
    email: str = Field(..., min_length=1, max_length=128)
    code: str = Field(..., min_length=6, max_length=6)


class LoginCodeResponse(BaseModel):
    """老用户：token+user；新用户：need_register=True"""

    token: str | None = None
    user: UserPublic | None = None
    need_register: bool = False


class RegisterRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=6, max_length=6)
    nickname: str = Field(..., min_length=1, max_length=24)
    avatar_seed: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8)
    invite_code: str | None = None  # 系统零用户时免邀请码（首用户即管理员）


class LoginPasswordRequest(BaseModel):
    email_or_uid: str = Field(..., max_length=128, description="邮箱或 UID")
    password: str
    captcha_id: str | None = Field(None, max_length=64)
    captcha_answer: str | None = Field(None, max_length=16)


class UpdateProfileRequest(BaseModel):
    nickname: str | None = Field(None, min_length=1, max_length=24)
    avatar_seed: str | None = Field(None, min_length=1, max_length=64)
    bio: str | None = Field(None, max_length=100)


class ChangePasswordRequest(BaseModel):
    """设置页修改密码（需登录，旧密码通道）"""

    old_password: str
    new_password: str = Field(..., min_length=8)


class ResetPasswordRequest(BaseModel):
    """忘记密码（免登录，验证码通道）。email 兼容邮箱或 UID"""

    email: str = Field(..., min_length=1, max_length=128)
    code: str = Field(..., min_length=6, max_length=6)
    new_password: str = Field(..., min_length=8)
