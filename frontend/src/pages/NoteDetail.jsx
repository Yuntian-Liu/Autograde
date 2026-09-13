import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { App as AntApp, Modal } from "antd";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { clientLog } from "../utils/clientLog";

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

// 笔记详情：所见即所得编辑（粘贴图片 → 直传 COS → 内联显示）
export default function NoteDetail() {
  const { id } = useParams();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const editorRef = useRef(null);

  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [uploading, setUploading] = useState(0);

  useEffect(() => {
    apiGet(`/notes/${id}`)
      .then((n) => {
        setNote(n);
        if (editorRef.current) {
          editorRef.current.innerHTML = contentToHtml(n.content, n.image_urls || {});
        }
      })
      .catch((e) => setError(e.message));
  }, [id]);

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
      document.execCommand(
        "insertHTML",
        false,
        `<img class="note-img" src="${URL.createObjectURL(file)}" data-key="${res.key}" alt="" />`
      );
      setDirty(true);
    } catch (e) {
      message.error(e.message);
    } finally {
      setUploading((n) => n - 1);
    }
  }

  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    e.preventDefault();
    if (files.length > 0) {
      for (const f of files) uploadImage(f);
    } else {
      // 纯文本粘贴（不带源格式）
      document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
    }
  }

  async function save() {
    if (!editorRef.current) return;
    setSaving(true);
    try {
      const content = serializeEditor(editorRef.current);
      const updated = await apiPatch(`/notes/${id}`, { content });
      setNote((prev) => ({ ...prev, ...updated }));
      setDirty(false);
      clientLog.add("ui", `保存笔记 #${id}`);
      message.success("已保存");
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
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
          <button className="btn danger" style={{ marginLeft: "auto" }} onClick={() => setDeleteOpen(true)}>
            删除笔记
          </button>
        </div>

        <div
          ref={editorRef}
          className="note-editor"
          contentEditable
          suppressContentEditableWarning
          onPaste={onPaste}
          onInput={() => setDirty(true)}
        />
        {uploading > 0 && <div className="page-meta">图片上传中…</div>}
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
