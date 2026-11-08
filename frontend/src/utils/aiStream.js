import { clearToken, getToken, UNAUTHORIZED_EVENT } from "../api";
import { trackedFetch } from "./trackedFetch";

async function responseError(response) {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    // 保留状态码
  }
  return new Error(detail);
}

export async function streamAI(path, payload, { onEvent, signal } = {}) {
  const response = await trackedFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    throw new Error("登录已过期，请重新登录");
  }
  if (!response.ok) throw await responseError(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      let event;
      try {
        event = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (event.type === "error") throw new Error(event.message || "AI 调用失败");
      onEvent?.(event);
      if (event.type === "done") completed = event;
    }
  }
  if (!completed) throw new Error("AI 连接中断，未收到完成结果");
  return completed;
}
