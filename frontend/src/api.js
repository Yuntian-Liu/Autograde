const BASE = "/api";

export async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && body.detail) detail = body.detail;
    } catch {
      /* 保留状态码描述 */
    }
    throw new Error(detail);
  }
  return res.json();
}
