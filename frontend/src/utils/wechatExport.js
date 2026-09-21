// 笔记 → 微信笔记一键复制：text/html 进剪贴板，图片以 data URI 内联（微信解析器认这个形态，实测通过）。
// 形态适配（均真机实测）：mark 标签微信不认 → 转 span+背景色；**微信只认 PNG 的 data URI，JPEG 会被静默丢弃**
// → 非 PNG 图片一律 canvas 解码重编码为 PNG（无损，体积膨胀但 17MB 实测可通过）。
import { contentToHtml, stripMarks } from "./noteFormat";

const WX_MARK_OPEN = '<span style="background-color:rgb(255,224,122)">';

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// 微信只收 PNG data URI：非 PNG 的用 canvas 转一道（JPEG/WebP 通吃；解码失败抛错由调用方计入失败）
async function toPngDataUri(blob) {
  if (blob.type === "image/png") return blobToDataUri(blob);
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  cv.getContext("2d").drawImage(bmp, 0, 0);
  const png = await new Promise((res) => cv.toBlob(res, "image/png"));
  if (!png) throw new Error("PNG 转码失败");
  return blobToDataUri(png);
}

// note: 详情接口的完整对象（content + image_urls）；onProgress(done, total) 报图片进度
// 返回 { total, failed }：失败的图片直接剔除（不带「图片未加载」占位进微信），由调用方提示
export async function copyNoteToWechat(note, { onProgress } = {}) {
  const keys = [...(note.content || "").matchAll(/\[\[img:([^\]]+)\]\]/g)].map((m) => m[1]);
  const dataUris = {};
  let failed = 0;
  for (let i = 0; i < keys.length; i++) {
    onProgress?.(i + 1, keys.length);
    const url = (note.image_urls || {})[keys[i]];
    if (!url) {
      failed++;
      continue;
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(String(resp.status));
      dataUris[keys[i]] = await toPngDataUri(await resp.blob());
    } catch {
      failed++;
    }
  }
  let html = contentToHtml(note.content, dataUris)
    .replaceAll("<mark>", WX_MARK_OPEN)
    .replaceAll("</mark>", "</span>")
    // 拉取失败的图片位置剔除占位，不污染微信侧
    .replace(/<span class="note-img-missing"[^>]*>\[图片未加载\]<\/span>/g, "");
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([stripMarks(note.content)], { type: "text/plain" }),
    }),
  ]);
  return { total: keys.length, failed };
}
