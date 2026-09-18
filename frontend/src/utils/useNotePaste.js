// 笔记图文粘贴共享逻辑：NoteDetail（正式笔记）与 NoteImport（批量导入行）共用。
// noteId 可空——空时图片走 tmp key，笔记创建后由后端 _reconcile_images 对账归属。
import { useState } from "react";
import { App as AntApp } from "antd";
import { apiPost } from "../api";
import { clientLog } from "./clientLog";
import { sanitizePastedHtml } from "./noteFormat";
import { blobExt, classifyImgSrc, dataUriToBlob, parseImgSrcs } from "./paste";

export function useNotePaste({ editorRef, noteId, onDirty }) {
  const { message } = AntApp.useApp();
  const [uploading, setUploading] = useState(0);
  const [migrating, setMigrating] = useState(""); // 图片迁移进度文字（底部保留）
  const [migrateBar, setMigrateBar] = useState(null); // { done, total, phase: run|done } 顶部进度条
  const [dragOver, setDragOver] = useState(false); // 拖拽悬停视觉反馈

  function insertImgHtml(key, src) {
    // 用 DOM API 插入而非 execCommand("insertHTML")——后者在编辑器失焦时静默失败（图片丢失根因）
    const editor = editorRef.current;
    if (!editor) return;
    const img = document.createElement("img");
    img.className = "note-img";
    img.src = src;
    img.dataset.key = key;
    img.alt = "";
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
      sel.getRangeAt(0).insertNode(img);
      clientLog.add("ui", `插图落地：光标处（${key}）`);
    } else {
      // 失焦时追加到编辑器末尾（最后一行 div 内，无则新建）
      let last = editor.lastElementChild;
      if (!last) {
        last = document.createElement("div");
        editor.appendChild(last);
      }
      last.appendChild(img);
      clientLog.add("ui", `插图落地：末尾（编辑器失焦，${key}）`);
    }
    // 光标移到刚插入的图片之后：insertNode 不动选区，不移的话连续插图会逐张倒序
    const after = document.createRange();
    after.setStartAfter(img);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);
    onDirty?.();
  }

  async function uploadImage(file) {
    setUploading((n) => n + 1);
    try {
      const res = await apiPost("/notes/upload-url", {
        filename: file.name || "pasted.png",
        size: file.size,
        note_id: noteId ?? null,
      });
      // 浏览器直传 COS（流量不经过我们服务器）
      const put = await fetch(res.upload_url, { method: "PUT", body: file });
      if (!put.ok) throw new Error(`上传失败（${put.status}）`);
      clientLog.add("ui", `笔记贴图上传：${file.name || "pasted"}（${file.size}B）`);
      insertImgHtml(res.key, URL.createObjectURL(file));
      onDirty?.();
    } catch (e) {
      message.error(e.message);
    } finally {
      setUploading((n) => n - 1);
    }
  }

  // 粘贴：files 通道（单张图）→ text/html 通道（清洗式：保留 b/i/mark，图片分流迁移）→ 纯文本
  async function onPaste(e) {
    e.preventDefault();
    const files = [...(e.clipboardData?.files || [])];
    if (files.length > 0) {
      for (const f of files) await uploadImage(f);
      return;
    }
    const html = e.clipboardData?.getData("text/html") || "";
    const srcs = html ? parseImgSrcs(html) : [];
    const text = e.clipboardData?.getData("text/plain") || "";
    if (srcs.length === 0) {
      // 清洗式粘贴：有 HTML 则保四种白名单格式剥其余标签，纯文本原样
      const clean = html ? sanitizePastedHtml(html) : "";
      document.execCommand(clean ? "insertHTML" : "insertText", false, clean || text);
      onDirty?.();
      return;
    }
    // 先落清洗后的文本（含原文的「[图片]」占位与保住的加粗），再逐张迁移
    const clean = sanitizePastedHtml(html);
    if (clean) document.execCommand("insertHTML", false, clean);
    else if (text) document.execCommand("insertText", false, text);
    let failed = 0;
    let fileLocal = 0; // file:// 本地路径（Windows 微信剪贴板不含图片数据）
    let i = 0;
    setMigrateBar({ done: 0, total: srcs.length, phase: "run" });
    for (const src of srcs) {
      i++;
      setMigrating(`正在迁移图片 ${i}/${srcs.length}`);
      try {
        const kind = classifyImgSrc(src);
        if (kind === "datauri") {
          const blob = dataUriToBlob(src);
          await uploadImage(new File([blob], `pasted.${blobExt(blob.type)}`, { type: blob.type }));
        } else if (kind === "http") {
          const res = await apiPost("/notes/fetch-image", { url: src, note_id: noteId ?? null });
          insertImgHtml(res.key, res.url);
          onDirty?.();
        } else {
          if (kind === "file") fileLocal++;
          failed++; // file:// / wx- 等拿不到的，保留原文占位
        }
      } catch {
        failed++;
      }
      setMigrateBar({ done: i, total: srcs.length, phase: "run" });
    }
    setMigrating("");
    // 满格短暂停留后淡出消失
    setMigrateBar({ done: srcs.length, total: srcs.length, phase: "done" });
    setTimeout(() => setMigrateBar(null), 900);
    if (fileLocal > 0) {
      message.warning("Windows 微信剪贴板不含图片数据，请直接把图片拖进编辑器");
    } else if (failed) {
      message.warning(`${srcs.length - failed} 张已迁移，${failed} 张无法自动迁移，需手动补`);
    } else {
      message.success(`已迁移 ${srcs.length} 张图片`);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    // Windows 微信补救：剪贴板拿不到图片时，直接拖文件进来
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    for (const f of files) uploadImage(f);
  }

  const dndProps = {
    onDragOver: (e) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop,
  };

  return { onPaste, dndProps, uploading, migrating, migrateBar, dragOver, insertImgHtml };
}
