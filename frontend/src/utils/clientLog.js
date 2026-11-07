// 前端诊断日志：环形缓冲（500 条）+ 全局错误捕获 + toast 采集 + 落库 flush
// （模块加载即挂载，白屏也留痕；构建信息见 boot 事件）
/* global __APP_VERSION__, __BUILD_TIME__ */
const MAX = 500;
const MAX_DETAIL = 1000;
const FLUSH_BATCH = 100;
const TOKEN_KEY = "autograde_token";

const buffer = [];
let addedCount = 0;
let flushedCount = 0;
let lastFlushedSeq = 0;
let droppedCount = 0;
let flushing = false;
let flushFailureCount = 0;
let consecutiveFlushFailures = 0;
let lastFlushAt = "";
let lastFlushResult = "idle";
let lastFlushError = "";

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function add(type, detail) {
  addedCount++;
  buffer.push({ seq: addedCount, ts: ts(), type, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  if (buffer.length > MAX) {
    buffer.shift();
    droppedCount++;
  }
}

function dump() {
  return [...buffer];
}

function pending() {
  return buffer.filter((event) => event.seq > lastFlushedSeq);
}

function health() {
  return {
    added: addedCount,
    flushed: flushedCount,
    dropped: droppedCount,
    pending: pending().length,
    flush_failures: flushFailureCount,
    consecutive_flush_failures: consecutiveFlushFailures,
    last_flush_at: lastFlushAt,
    last_flush_result: lastFlushResult,
    last_flush_error: lastFlushError,
  };
}

function operation(action, outcome, fields = {}) {
  const detail = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, " ").slice(0, 200)}`)
    .join(" ");
  add("operation", `${action} ${outcome}${detail ? ` ${detail}` : ""}`);
}

// 构建信息（诊断包可直接对比前后端版本）
add("boot", `build ${__APP_VERSION__} @ ${__BUILD_TIME__}`);

// ---- 落库 flush：每 20s + 页面隐藏/关闭时批量 POST /api/client-log（失败静默重试下次）----
async function flushEvents(keepalive = false) {
  if (flushing) return;
  const backlog = pending();
  if (!backlog.length) return;
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    lastFlushResult = "waiting_auth";
    return;
  }
  flushing = true;
  try {
    const batch = backlog.slice(0, FLUSH_BATCH);
    const events = batch.map((e) => ({ ts: e.ts, type: e.type, detail: String(e.detail).slice(0, 800) }));
    // 不用 api.js（它会给自己记日志造成自激；失败只更新健康状态）
    const res = await fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
      keepalive,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastFlushedSeq = Math.max(...batch.map((event) => event.seq));
    flushedCount += events.length;
    consecutiveFlushFailures = 0;
    lastFlushAt = ts();
    lastFlushResult = "success";
    lastFlushError = "";
  } catch (error) {
    flushFailureCount++;
    consecutiveFlushFailures++;
    lastFlushAt = ts();
    lastFlushResult = "failed";
    lastFlushError = String(error?.message || error).slice(0, 200);
  } finally {
    flushing = false;
  }
}

setInterval(() => flushEvents(), 20000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushEvents(true);
});
window.addEventListener("pagehide", () => flushEvents(true));

// ---- ① toast 入日志：antd message 全量采集（无需改调用点）----
const toastObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      const notice = node.matches?.(".ant-message-notice")
        ? node
        : node.querySelector?.(".ant-message-notice");
      if (!notice) continue;
      const content = notice.querySelector(".ant-message-custom-content");
      if (!content) continue;
      const kind = [...content.classList]
        .find((c) => c.startsWith("ant-message-") && c !== "ant-message-custom-content")
        ?.replace("ant-message-", "");
      const text = content.textContent?.trim();
      if (text) add("toast", `${kind || "info"}: ${text}`.slice(0, 300));
    }
  }
});
toastObserver.observe(document.body, { childList: true, subtree: true });

// ---- ⑤ JS 错误记堆栈 + 资源加载错误（capture=true 才能拿到资源错误）----
window.addEventListener(
  "error",
  (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      add("error", `资源加载失败: ${t.src || t.href}`.slice(0, MAX_DETAIL));
      return;
    }
    const msg = e.error?.stack || e.message || "未知错误";
    add("error", `${e.filename || ""}:${e.lineno || ""} ${msg}`.slice(0, MAX_DETAIL));
  },
  true
);

// Promise 未处理 rejection（stack 优先，不再只留 message）
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason?.stack || e.reason?.message || String(e.reason || "");
  add("error", `Promise ${reason}`.slice(0, MAX_DETAIL));
});

export const clientLog = { add, dump, pending, health, operation };
