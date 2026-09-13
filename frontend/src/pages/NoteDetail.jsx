import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { App as AntApp, Modal } from "antd";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { clientLog } from "../utils/clientLog";
import { blobExt, classifyImgSrc, dataUriToBlob, parseImgSrcs } from "../utils/paste";

// 存储格式：文本行 + 图片占位符 [[img:key]]；编辑态 DOM 即模型，保存时序列化回存储格式
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function contentToHtml(content, imageUrls) {
  return (content || "")
    .split("\n")
    .map((line) => {
      const html = esc(line).replace(/\[\[img:([^\]]+)\]\]/g, (_, key) =>
        imageUrls[key]
          ? `<img class="note-img" src="${imageUrls[key]}" data-key="${key}" alt="" />`
          : `<span class="note-img-missing">[图片未加载]</span>`
      );
      return `<div>${html || "<br>"}</div>`;
    })
    .join("");
}

function inlineText(node) {
  let out = "";
  for (const n of node.childNodes ?? []) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent;
    else if (n.nodeName === "IMG") out += `[[img:${n.dataset.key}]]`;
    else if (n.nodeName === "BR") out += "";
    else out += inlineText(n);
  }
  return out;
}

function serializeEditor(root) {
  const lines = [];
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) lines.push(child.textContent);
    else lines.push(inlineText(child));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 笔记详情：默认阅读模式，编辑是主动动作
export default function NoteDetail() {
  const { id } = useParams();
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const editorRef = useRef(null);
  const editorInitRef = useRef(false); // 每次进入编辑态只写一次内容（不覆盖用户编辑）

  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [migrating, setMigrating] = useState(""); // 图片迁移进度文字（底部保留）
  const [migrateBar, setMigrateBar] = useState(null); // { done, total, phase: run|done } 顶部进度条

  // 防丢保护：编辑态且有未保存修改时，所有离开路径都要确认
  const blocking = editing && dirty;

  // ① 页面内导航拦截（返回链接/面包屑/任意路由跳转；useBlocker 需 data router）
  const blocker = useBlocker(blocking);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    modal.confirm({
      title: "有未保存的修改",
      content: "确定离开？未保存的修改将丢失。",
      okText: "离开",
      cancelText: "继续编辑",
      centered: true,
      okButtonProps: { danger: true },
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);

  // ② 浏览器关标签/刷新拦截（离开编辑态/保存成功/卸载时移除监听）
  useEffect(() => {
    if (!blocking) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [blocking]);

  // 数据加载只 setNote；DOM 写入在下方 effect（修「点进笔记内容空白」时序 bug）
  useEffect(() => {
    setNote(null);
    setEditing(false);
    setDirty(false);
    editorInitRef.current = false;
    apiGet(`/notes/${id}`)
      .then(setNote)
      .catch((e) => setError(e.message));
  }, [id]);

  // 渲染后（编辑态容器已挂载）再写内容；每次进入编辑态写一次
  useEffect(() => {
    if (editing && note && editorRef.current && !editorInitRef.current) {
      editorRef.current.innerHTML = contentToHtml(note.content, note.image_urls || {});
      editorInitRef.current = true;
    }
  }, [editing, note]);

  function insertImgHtml(key, src) {
    document.execCommand(
      "insertHTML",
      false,
      `<img class="note-img" src="${src}" data-key="${key}" alt="" />`
    );
  }

  async function uploadImage(file) {
    setUploading((n) => n + 1);
    try {
      const res = await apiPost("/notes/upload-url", {
        filename: file.name || "pasted.png",
        size: file.size,
        note_id: Number(id),
      });
      // 浏览器直传 COS（流量不经过我们服务器）
      const put = await fetch(res.upload_url, { method: "PUT", body: file });
      if (!put.ok) throw new Error(`上传失败（${put.status}）`);
      clientLog.add("ui", `笔记贴图上传：${file.name || "pasted"}（${file.size}B）`);
      insertImgHtml(res.key, URL.createObjectURL(file));
      setDirty(true);
    } catch (e) {
      message.error(e.message);
    } finally {
      setUploading((n) => n - 1);
    }
  }

  // 粘贴：files 通道（单张图）→ text/html 通道（微信整篇，<img> 分流迁移）→ 纯文本
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
      document.execCommand("insertText", false, text);
      return;
    }
    // 先落纯文本（含原文的「[图片]」占位），再逐张迁移
    if (text) document.execCommand("insertText", false, text);
    let failed = 0;
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
          const res = await apiPost("/notes/fetch-image", { url: src, note_id: Number(id) });
          insertImgHtml(res.key, res.url);
          setDirty(true);
        } else {
          failed++; // wx-、file:// 等拿不到的 scheme 保留原文占位
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
    if (failed) {
      message.warning(`${srcs.length - failed} 张已迁移，${failed} 张无法自动迁移，需手动补`);
    } else {
      message.success(`已迁移 ${srcs.length} 张图片`);
    }
  }

  async function save() {
    if (!editorRef.current) return;
    setSaving(true);
    try {
      const content = serializeEditor(editorRef.current);
      const updated = await apiPatch(`/notes/${id}`, { content });
      setNote((prev) => ({ ...prev, ...updated, content }));
      setDirty(false);
      setEditing(false);
      editorInitRef.current = false;
      clientLog.add("ui", `保存笔记 #${id}`);
      message.success("已保存");
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  function cancelEdit() {
    const exit = () => {
      setEditing(false);
      setDirty(false);
      editorInitRef.current = false;
    };
    if (!dirty) return exit();
    modal.confirm({
      title: "放弃未保存的修改？",
      content: "编辑内容尚未保存，退出编辑将丢弃这些修改。",
      okText: "放弃修改",
      cancelText: "继续编辑",
      centered: true,
      okButtonProps: { danger: true },
      onOk: exit,
    });
  }

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(note.content);
      message.success("已复制全文");
    } catch {
      message.error("复制失败，请检查浏览器剪贴板权限");
    }
  }

  // 阅读态图片点击 → 新开标签页看原图（签名 URL 直达，浏览器原生支持右键复制/另存）
  function onReaderClick(e) {
    const img = e.target.closest?.("img[data-key]");
    if (img) window.open(img.src, "_blank");
  }

  // 签名 URL 过期（1 小时）：img 加载失败时提示刷新重签
  function onReaderErrorCapture(e) {
    if (e.target.tagName === "IMG") {
      message.warning("图片链接已过期，请刷新页面重新获取");
    }
  }

  // 下载全部图片：签名 URL 跨域 a[download] 不生效，先 fetch 转 blob 触发真下载；
  // CORS 受限时退化为逐个新开标签页
  async function downloadAllImages() {
    const keys = [...(note.content || "").matchAll(/\[\[img:([^\]]+)\]\]/g)].map((m) => m[1]);
    const entries = keys
      .map((key) => ({ key, url: (note.image_urls || {})[key] }))
      .filter((e) => e.url);
    if (entries.length === 0) return message.warning("图片链接已过期，请刷新页面重新获取");
    for (let i = 0; i < entries.length; i++) {
      const ext = entries[i].key.rsplit(".", 1)[1] || "png";
      const name = `note-${id}-${i + 1}.${ext}`;
      try {
        const resp = await fetch(entries[i].url);
        if (!resp.ok) throw new Error(String(resp.status));
        const blob = await resp.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch {
        window.open(entries[i].url, "_blank");
      }
    }
    message.success(`已处理 ${entries.length} 张图片`);
  }

  async function remove() {
    try {
      await apiDelete(`/notes/${id}`);
      clientLog.add("ui", `删除笔记 #${id}`);
      message.success("笔记已删除");
      navigate("/notes");
    } catch (e) {
      message.error(e.message);
    }
  }

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!note)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const linkLine = note.class_name
    ? [note.class_name, note.student_name, note.assignment_label].filter(Boolean).join(" · ")
    : "历史记录";

  return (
    <div className="page-enter">
      <AppHeader crumbs={[{ label: "工作台", to: "/" }, { label: "笔记库", to: "/notes" }, { label: note.title }]} />
      <div className="wrap">
        <Link className="back" to="/notes">
          ← 笔记库
        </Link>
        <div className="page-meta" style={{ marginTop: "var(--s3)" }}>
          {linkLine} · 更新于 {(note.updated_at || "").slice(0, 16).replace("T", " ")}
        </div>

        <div className="btn-row" style={{ marginTop: "var(--s3)" }}>
          {editing ? (
            <>
              <button
                type="button"
                className="btn"
                onMouseDown={(e) => {
                  e.preventDefault(); // 保住选区
                  document.execCommand("bold");
                  setDirty(true);
                }}
              >
                加粗
              </button>
              <button className="btn primary" onClick={save} disabled={saving || !dirty}>
                {saving ? "保存中…" : "保存"}
              </button>
              <button className="btn" onClick={cancelEdit} disabled={saving}>
                取消
              </button>
            </>
          ) : (
            <>
              <button
                className="btn primary"
                onClick={() => {
                  setEditing(true);
                  editorInitRef.current = false; // 进入编辑态时重新写入最新内容
                }}
              >
                编辑
              </button>
              <button className="btn" onClick={copyContent}>
                复制全文
              </button>
              {(note.image_urls && Object.keys(note.image_urls).length > 0) && (
                <button className="btn" onClick={downloadAllImages}>
                  下载全部图片
                </button>
              )}
            </>
          )}
          <button className="btn danger" style={{ marginLeft: "auto" }} onClick={() => setDeleteOpen(true)}>
            删除笔记
          </button>
        </div>

        {editing ? (
          <>
            {migrateBar && (
              <div className={`migrate-bar ${migrateBar.phase}`}>
                <div className="migrate-track">
                  <div
                    className="migrate-fill"
                    style={{ width: `${(migrateBar.done / migrateBar.total) * 100}%` }}
                  />
                </div>
                <div className="migrate-text">
                  {migrateBar.phase === "done"
                    ? `已迁移 ${migrateBar.total} 张图片`
                    : `正在迁移图片 ${migrateBar.done}/${migrateBar.total}`}
                </div>
              </div>
            )}
            <h1 className="note-title">{note.title}</h1>
            <div
              ref={editorRef}
              className="note-editor"
              contentEditable
              suppressContentEditableWarning
              onPaste={onPaste}
              onInput={() => setDirty(true)}
            />
            {uploading > 0 && <div className="page-meta">图片上传中…</div>}
            {migrating && <div className="page-meta">{migrating}</div>}
          </>
        ) : (
          <>
            <h1 className="note-title">{note.title}</h1>
            <div
              className="note-reader"
              onClick={onReaderClick}
              onErrorCapture={onReaderErrorCapture}
              dangerouslySetInnerHTML={{
                __html: contentToHtml(note.content, note.image_urls || {}),
              }}
            />
          </>
        )}
      </div>

      <Modal
        centered
        open={deleteOpen}
        onCancel={() => setDeleteOpen(false)}
        onOk={remove}
        okButtonProps={{ danger: true }}
        title="删除笔记"
        okText="删除"
        cancelText="取消"
        width={400}
      >
        <p className="danger-text">删除后不可恢复，笔记内的图片将一并清除。</p>
      </Modal>
    </div>
  );
}
