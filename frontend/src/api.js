const BASE = "/api";
const TOKEN_KEY = "autograde_token";
import { clientLog } from "./utils/clientLog";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// 401 全局事件：AuthContext 监听后清登录态，App 监听后跳 /login
export const UNAUTHORIZED_EVENT = "autograde:unauthorized";

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const startedAt = Date.now();
  const method = options.method || "GET";
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...options, headers });
  } catch (e) {
    clientLog.add("network", `${method} ${path} 网络错误: ${e.message}`);
    throw e;
  }
  clientLog.add("api", `${method} ${path} ${res.status} ${Date.now() - startedAt}ms`);
  if (res.status === 401) {
    clientLog.add("auth", `401 ${method} ${path} → 清登录态`);
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    let detail = "登录已过期，请重新登录";
    try {
      const body = await res.json();
      if (body && body.detail) detail = typeof body.detail === "string" ? body.detail : detail;
    } catch {
      /* 保留默认文案 */
    }
    throw new Error(detail);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.detail) {
        detail =
          typeof body.detail === "string"
            ? body.detail
            : Array.isArray(body.detail)
              ? body.detail.map((d) => d.msg || JSON.stringify(d)).join("；")
              : detail;
      }
    } catch {
      /* 保留状态码描述 */
    }
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

const jsonBody = (method) => (path, data) =>
  request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

export const apiGet = (path) => request(path);
export const apiPost = jsonBody("POST");
export const apiPut = jsonBody("PUT");
export const apiPatch = jsonBody("PATCH");
export const apiDelete = (path) => request(path, { method: "DELETE" });

// ---- 认证接口 ----
export const authApi = {
  checkEmail: (email) => apiPost("/auth/check-email", { email }),
  // captcha: { captchaId, answer }（dev 模式后端 bypass，可传 null 占位）
  sendCode: (email, captcha) =>
    apiPost("/auth/send-code", {
      email,
      captcha_id: captcha?.captchaId ?? null,
      captcha_answer: captcha?.answer ?? null,
    }),
  loginCode: (email, code) => apiPost("/auth/login-code", { email, code }),
  register: (payload) => apiPost("/auth/register", payload),
  loginPassword: (emailOrUid, password, captcha) =>
    apiPost("/auth/login-password", {
      email_or_uid: emailOrUid,
      password,
      captcha_id: captcha?.captchaId ?? null,
      captcha_answer: captcha?.answer ?? null,
    }),
  getMe: () => apiGet("/auth/me"),
};

// ---- 管理后台 ----
export const adminApi = {
  overview: () => apiGet("/admin/overview"),
  aiUsage: (window) => apiGet(`/admin/ai-usage?window=${encodeURIComponent(window)}`),
  getPrices: () => apiGet("/admin/ai-prices"),
  setPrices: (prices) => apiPut("/admin/ai-prices", prices),
  security: () => apiGet("/admin/security-status"),
  inviteCodes: () => apiGet("/admin/invite-codes"),
  createInvites: (body) => apiPost("/admin/invite-codes", body),
  revokeInvite: (id) => apiDelete(`/admin/invite-codes/${id}`),
};

// 备份下载：POST 返回二进制流，前端 blob 触发保存
export async function downloadBackup() {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/admin/backup`, { method: "POST", headers });
  if (!res.ok) throw new Error(`备份失败：${res.status}`);
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename="?([^";]+)"?/.exec(cd);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = m?.[1] || "autograde-backup.db";
  a.click();
  URL.revokeObjectURL(a.href);
}
