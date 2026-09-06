const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
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
