// 前端诊断日志：环形缓冲（500 条）+ 全局错误捕获（模块加载即挂载，白屏也留痕）
const MAX = 500;
const buffer = [];

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function add(type, detail) {
  buffer.push({ ts: ts(), type, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  if (buffer.length > MAX) buffer.shift();
}

function dump() {
  return [...buffer];
}

// JS 运行时异常（未捕获同步错误 + 资源加载错误）
window.addEventListener("error", (e) => {
  const msg = e.error?.stack || e.message || "未知错误";
  add("error", `${e.filename || ""}:${e.lineno || ""} ${msg}`.slice(0, 500));
});

// Promise 未处理 rejection（async 错误、fetch 失败等）
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason?.message || e.reason?.stack || String(e.reason || "");
  add("error", `Promise ${reason}`.slice(0, 500));
});

export const clientLog = { add, dump };
