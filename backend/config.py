"""全局配置：认证与邮件相关环境变量（Autograde 单一配置入口）。

生产部署必须显式配置 JWT_SECRET / RESEND_API_KEY / RESEND_FROM / IS_PROD；
IS_PROD=true 时启动校验缺失项并打印中文警告（见 main.py lifespan）。
代码不硬编码任何域名——发件域名只存在于 RESEND_FROM 环境变量。
"""

import os

from dotenv import load_dotenv

load_dotenv()

# ---- 运行模式：false=开发（验证码打印日志、图形验证码 bypass）；true=生产 ----
IS_PROD = os.getenv("IS_PROD", "false").strip().lower() in ("1", "true", "yes")

# ---- JWT ----
JWT_SECRET = os.getenv("JWT_SECRET", "").strip() or "dev-secret-change-me"
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_DAYS = 7  # 单 token，无 refresh；吊销机制（token_version）留待管理后台版本

# ---- Resend 邮件（HTTP API 直调，不用 SDK）----
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
# 发件人：形如 "Autograde <noreply@mail.example.com>"，域名走 env 不入代码
RESEND_FROM = os.getenv("RESEND_FROM", "").strip()

# ---- 前端静态目录（单服务部署时 FastAPI 托管 dist）----
FRONTEND_DIST = os.getenv("FRONTEND_DIST", "").strip()

# ---- 阿里云 ESA 人机验证（身份标 prefix；配置后登录链路走边缘验签，源站跳过自托管图形码）----
ALIYUN_CAPTCHA_PREFIX = os.getenv("ALIYUN_CAPTCHA_PREFIX", "").strip()

# ---- 腾讯云 COS（笔记图片对象存储；空配置整体禁用，本地开发零负担）----
COS_SECRET_ID = os.getenv("COS_SECRET_ID", "").strip()
COS_SECRET_KEY = os.getenv("COS_SECRET_KEY", "").strip()
COS_BUCKET = os.getenv("COS_BUCKET", "").strip()  # 形如 notes-1250000000
COS_REGION = os.getenv("COS_REGION", "").strip()  # 如 ap-guangzhou
