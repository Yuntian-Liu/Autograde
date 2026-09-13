// 粘贴图片分流工具（纯函数，便于 node 侧验证；微信笔记整篇复制时图片在 text/html 的 <img> 里）

// data:image/... → 转 Blob 直传；http(s) → 后端 fetch-image 代取；
// file:// → Windows 微信本地路径（浏览器读不到，单独识别给拖拽指引）；其余 → unsupported
export function classifyImgSrc(src) {
  if (src.startsWith("data:image/")) return "datauri";
  if (/^https?:\/\//i.test(src)) return "http";
  if (/^file:\/\//i.test(src)) return "file";
  return "unsupported";
}

export function dataUriToBlob(uri) {
  const [head, data] = uri.split(",");
  const mime = /data:(.*?)(;|$)/.exec(head)?.[1] || "image/png";
  const bin = atob(data);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

export function blobExt(mime) {
  const sub = (mime.split("/")[1] || "png").toLowerCase();
  return sub === "jpeg" ? "jpg" : sub;
}

// 从粘贴 HTML 解析全部 <img> src 并去重（同一张图一次粘贴可能出现多次，只传一次）
export function parseImgSrcs(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...new Set([...doc.querySelectorAll("img")].map((i) => i.getAttribute("src") || "").filter(Boolean))];
}
