import { clientLog } from "./clientLog";

export function newRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function trackedFetch(input, options = {}) {
  const { logLabel, ...fetchOptions } = options;
  const requestId = newRequestId();
  const sameOriginApi = typeof input === "string" && input.startsWith("/api");
  const headers = { ...(fetchOptions.headers || {}) };
  if (sameOriginApi) headers["X-Request-ID"] = requestId;
  const method = fetchOptions.method || "GET";
  const label = logLabel || (sameOriginApi ? input.split("?")[0] : "外部资源");
  const startedAt = Date.now();
  try {
    const response = await fetch(input, { ...fetchOptions, headers });
    clientLog.add("api", `${method} ${label} ${response.status} ${Date.now() - startedAt}ms rid=${requestId}`);
    return response;
  } catch (error) {
    clientLog.add("network", `${method} ${label} 网络错误 rid=${requestId} ${error.message}`.slice(0, 500));
    throw error;
  }
}
