"""自托管图形人机验证（自 Stellaris 移植，替代第三方验证码服务）。

安全模型（安全边界全在本模块，图形只是展示层）：
- 答案只存服务端内存：{captcha_id: (answer, expires_at)}，5 分钟过期
- 一次性：校验即删（无论对错），防重放
- captcha_id 用 uuid4，防枚举
- 生成端点 IP 限流（路由层，30/min）
- 懒清理：生成时顺手扫过期项，容量有界
- dev bypass：IS_PROD=false 直接放行；socket peer 为本机 + 魔数答案放行——
  **调用方必须传 request.client.host（socket peer），不得传 XFF 推导值**（XFF 可伪造）
- 生产 fail-closed：答案错/过期/不存在一律拒绝
"""

import base64
import secrets
import threading
import time
import unicodedata
import uuid

from captcha.image import ImageCaptcha

from config import IS_PROD

CAPTCHA_TTL_SEC = 300  # 5 分钟过期
_DEV_ANSWER = "dev-bypass"  # 本机联调魔数（仅本机 IP 生效）

_store: dict[str, tuple[str, float]] = {}  # captcha_id → (answer, 过期时间戳)
_lock = threading.Lock()  # to_thread 后 store 与渲染都跨线程
_image = ImageCaptcha(width=160, height=60)

# 去混淆字符集：剔 0/O、1/I/L 等
_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"


def _new_challenge() -> tuple[str, str]:
    """返回（图像文本, 正确答案）。纯 4 位随机字符——31 字符去混淆集，约 92 万组合。"""
    text = "".join(secrets.choice(_CHARS) for _ in range(4))
    return text, text


def new_captcha() -> dict:
    """生成一道题，返回 {captcha_id, image(data URI)}。"""
    with _lock:
        now = time.time()
        expired = [k for k, (_, exp) in _store.items() if exp < now]
        for k in expired:
            _store.pop(k, None)

        text, answer = _new_challenge()
        captcha_id = uuid.uuid4().hex
        _store[captcha_id] = (answer, now + CAPTCHA_TTL_SEC)
        png = _image.generate(text)
    return {
        "captcha_id": captcha_id,
        "image": "data:image/png;base64," + base64.b64encode(png.getvalue()).decode(),
    }


async def verify_captcha(
    captcha_id: str | None, answer: str | None, remote_ip: str | None = None
) -> bool:
    """校验图形验证码。一次性：校验即删（无论对错）。"""
    if not IS_PROD:
        return True
    if remote_ip in ("127.0.0.1", "::1", "localhost") and answer == _DEV_ANSWER:
        return True
    if not captcha_id or not answer:
        return False
    with _lock:
        item = _store.pop(captcha_id, None)  # 一次性：无论对错都删除（锁内 pop，互斥闭合）
    if not item:
        return False
    expected, expires_at = item
    if time.time() > expires_at:
        return False
    # NFKC 归一：中文输入法全角字母转半角，免得用户答对被判错
    return unicodedata.normalize("NFKC", answer.strip()).lower() == expected.lower()
