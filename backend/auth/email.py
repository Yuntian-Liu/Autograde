"""Resend 邮件 — 验证码邮件（HTTP API 直调，不用 SDK）。

- IS_PROD=false：验证码打印到日志（开发不烧 Resend 额度）
- 生产：渲染 HTML（Autograde 蓝绿主题）+ httpx 调 Resend（放线程池）
- 发件人只从 RESEND_FROM 环境变量读，代码不硬编码任何域名
"""

import asyncio

import httpx

from config import IS_PROD, RESEND_API_KEY, RESEND_FROM


def _render_verification_html(code: str) -> str:
    """Autograde 蓝绿主题验证码邮件（table 布局 + 内联 CSS，邮件客户端兼容）。"""
    return f"""\
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7fafa;font-family:'PingFang SC','Noto Sans SC',-apple-system,BlinkMacSystemFont,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7fafa;padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 6px 20px rgba(22,32,43,.09)">
        <!-- 品牌头：蓝绿主题色 -->
        <tr>
          <td style="background:#0d9aa7;padding:32px 24px;text-align:center">
            <div style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:2px">Autograde</div>
            <div style="font-size:12px;color:#e6f5f6;margin-top:8px;letter-spacing:1px">英语作业批改工作台</div>
          </td>
        </tr>
        <!-- 主内容 -->
        <tr>
          <td style="padding:36px 28px 12px;text-align:center">
            <p style="color:#51606f;font-size:15px;margin:0 0 4px">你的邮箱正在用于登录 Autograde</p>
            <p style="color:#93a1af;font-size:12px;margin:0 0 24px">请使用下方验证码完成验证</p>
            <!-- 验证码区 -->
            <div style="background:#e6f5f6;border:2px dashed #0d9aa7;border-radius:12px;padding:24px 16px;margin:0 0 20px">
              <div style="color:#0a7f8a;font-size:11px;font-weight:700;letter-spacing:3px;margin-bottom:10px">验证码</div>
              <div style="font-size:42px;font-weight:800;letter-spacing:12px;color:#16202b;font-family:'JetBrains Mono','Courier New',monospace">{code}</div>
            </div>
            <!-- 有效期提示 -->
            <div style="display:inline-block;background:#fef3c7;border-radius:20px;padding:6px 14px;margin-bottom:8px">
              <span style="color:#92400e;font-size:12px;font-weight:600">验证码 5 分钟内有效，请勿泄露</span>
            </div>
          </td>
        </tr>
        <!-- 安全提示 -->
        <tr>
          <td style="padding:8px 28px 24px;text-align:center">
            <div style="color:#93a1af;font-size:12px;line-height:1.7">
              如果这不是你本人的操作，请忽略此邮件
            </div>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:16px 28px 24px;border-top:1px solid #e5ebee;text-align:center">
            <p style="color:#93a1af;font-size:11px;margin:0;line-height:1.7">
              此邮件由系统自动发送，请勿直接回复<br>
              <span style="color:#0d9aa7;font-weight:700">Autograde</span>
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _send_via_resend_sync(email: str, html: str) -> None:
    """同步调 Resend REST API（放线程池跑，不阻塞事件循环）。"""
    if not RESEND_API_KEY:
        raise RuntimeError("RESEND_API_KEY 未配置")
    if not RESEND_FROM:
        raise RuntimeError("RESEND_FROM 未配置（形如 Autograde <noreply@verify.example.cn>）")
    resp = httpx.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "from": RESEND_FROM,
            "to": [email],
            "subject": "【Autograde】登录验证码",
            "html": html,
        },
        timeout=30.0,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"Resend 返回 {resp.status_code}: {resp.text}")


async def send_verification_code(email: str, code: str) -> None:
    """发验证码邮件：dev 打日志，prod 调 Resend。"""
    if not IS_PROD:
        print(f"\n[DEV] Autograde 验证码 → {email} : {code}\n")
        return
    html = _render_verification_html(code)
    await asyncio.to_thread(_send_via_resend_sync, email, html)
