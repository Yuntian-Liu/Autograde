// 笔记 → 微信笔记一键复制：text/html 进剪贴板，图片以 data URI 内联（微信解析器认这个形态，实测通过）。
// 两个形态适配：mark 标签微信不认，导出时转 span+背景色；图片不压缩（原图本就来自微信，体积已被验证可行）。
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
      dataUris[keys[i]] = await blobToDataUri(await resp.blob());
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
