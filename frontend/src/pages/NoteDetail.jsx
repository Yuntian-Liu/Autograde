import { useEffect, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router-dom";
import { App as AntApp, Input, Modal } from "antd";
import { apiDelete, apiGet, apiPatch, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import SaveStatus from "../components/SaveStatus";
import PageSkeleton from "../components/PageSkeleton";
import { fmtTime } from "../meta";
import { clientLog } from "../utils/clientLog";
import { fp } from "../utils/contentfp";
import { useNotePaste } from "../utils/useNotePaste";
import { contentToHtml, serializeEditor, stripMarks } from "../utils/noteFormat";
import { IconBold, IconHighlight, IconItalic } from "../components/icons";

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
  const [saveFailed, setSaveFailed] = useState(false); // 上次保存失败（状态灯红灯）
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false); // 归档弹窗（填学生名/备注）
  const [legacyNameDraft, setLegacyNameDraft] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [fmt, setFmt] = useState({ bold: false, italic: false }); // 选区格式状态（工具栏高亮）
  const [titleDraft, setTitleDraft] = useState(""); // 编辑态标题草稿
  const [titleEdited, setTitleEdited] = useState(false); // 手动改过才随 PATCH 提交（否则后端按首行自动重算）

  // 图文粘贴全套（上传/迁移/落地/拖拽）：共享 hook，批量导入页同款
  const markDirty = () => setDirty(true);
  const { onPaste, dndProps, uploading, migrating, migrateBar, dragOver } = useNotePaste({
    editorRef,
    noteId: Number(id),
    onDirty: markDirty,
  });

  // 选区格式状态同步（高亮 mark 无 queryCommandState，只跟 bold/italic）
  function syncFmt() {
    try {
      setFmt({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
      });
    } catch {
      /* 无选区时忽略 */
    }
  }

  // 高亮：选区在 mark 内再点取消，否则包 mark（跨节点选区放弃）
  function applyMark() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const inMark = range.commonAncestorContainer.parentElement?.closest?.("mark");
    if (inMark) {
      inMark.replaceWith(...inMark.childNodes);
    } else {
      try {
        range.surroundContents(document.createElement("mark"));
      } catch {
        /* 跨节点选区忽略 */
      }
    }
    setDirty(true);
  }

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


  async function save() {
    if (!editorRef.current) return;
    setSaving(true);
    try {
      const content = serializeEditor(editorRef.current);
      const body = { content };
      if (titleEdited) body.title = titleDraft;
      await apiPatch(`/notes/${id}`, body);
      // PATCH 响应不含 image_urls：取回完整笔记，新贴图立即以签名 URL 渲染（否则误显「图片未加载」）
      const fresh = await apiGet(`/notes/${id}`);
      setNote(fresh);
      setDirty(false);
      setEditing(false);
      editorInitRef.current = false;
      const imgCount = (content.match(/\[\[img:/g) || []).length;
      clientLog.add("ui", `保存笔记 #${id} len=${content.length} img=${imgCount} fp=${fp(content)}`);
      setSaveFailed(false);
      message.success("已保存");
    } catch (e) {
      setSaveFailed(true);
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
      // 双格式：text/plain 剥标记可读，text/html 带排版（微信笔记等保留加粗/倾斜/高亮）
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([stripMarks(note.content)], { type: "text/plain" }),
          "text/html": new Blob([contentToHtml(note.content, note.image_urls || {})], {
            type: "text/html",
          }),
        }),
      ]);
      message.success("已复制全文");
    } catch {
      try {
        await navigator.clipboard.writeText(stripMarks(note.content));
        message.success("已复制全文");
      } catch {
        message.error("复制失败，请检查浏览器剪贴板权限");
      }
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

  async function archive() {
    setArchiving(true);
    try {
      const res = await apiPost(`/notes/${id}/archive`, { legacy_name: legacyNameDraft.trim() });
      setNote((prev) => ({ ...prev, archived: true, legacy_name: res.legacy_name }));
      clientLog.add("ui", `归档笔记 #${id}${res.legacy_name ? `（${res.legacy_name}）` : ""}`);
      message.success("已归档（笔记库 → 归档区可见）");
      setArchiveOpen(false);
    } catch (e) {
      message.error(e.message);
    } finally {
      setArchiving(false);
    }
  }

  async function unarchive() {
    try {
      await apiPost(`/notes/${id}/unarchive`);
      setNote((prev) => ({ ...prev, archived: false }));
      clientLog.add("ui", `还原笔记 #${id} 回活跃区`);
      message.success("已还原到活跃区");
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

  const linkLine = note.archived
    ? `归档${note.legacy_name ? ` · ${note.legacy_name}` : ""}`
    : note.class_name
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
          {linkLine} · 更新于 {fmtTime(note.updated_at)}
        </div>

        <div className="btn-row" style={{ marginTop: "var(--s3)" }}>
          {editing ? (
            <>
              <div className="note-toolbar">
                <button
                  type="button"
                  className={`fmt-btn ${fmt.bold ? "on" : ""}`}
                  title="加粗"
                  onMouseDown={(e) => {
                    e.preventDefault(); // 保住选区
                    document.execCommand("bold");
                    syncFmt();
                    setDirty(true);
                  }}
                >
                  <IconBold />
                </button>
                <button
                  type="button"
                  className={`fmt-btn ${fmt.italic ? "on" : ""}`}
                  title="倾斜"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    document.execCommand("italic");
                    syncFmt();
                    setDirty(true);
                  }}
                >
                  <IconItalic />
                </button>
                <button
                  type="button"
                  className="fmt-btn"
                  title="高亮"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyMark();
                  }}
                >
                  <IconHighlight />
                </button>
              </div>
              <button className="btn primary" onClick={save} disabled={saving || !dirty}>
                {saving ? "保存中…" : "保存"}
              </button>
              <SaveStatus dirty={dirty} saving={saving} failed={saveFailed} />
              <button className="btn" onClick={cancelEdit} disabled={saving}>
                取消
              </button>
            </>
          ) : (
            <>
              <button
                className="btn primary"
                onClick={() => {
                  setTitleDraft(note.title);
                  setTitleEdited(false);
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
              {note.archived ? (
                <button className="btn" onClick={unarchive}>
                  还原到活跃区
                </button>
              ) : (
                <button
                  className="btn"
                  onClick={() => {
                    setLegacyNameDraft(note.legacy_name || "");
                    setArchiveOpen(true);
                  }}
                >
                  归档
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
            <input
              className="note-title-input"
              value={titleDraft}
              maxLength={128}
              placeholder="笔记标题（留空则取正文首行）"
              onChange={(e) => {
                setTitleDraft(e.target.value);
                setTitleEdited(true);
                setDirty(true);
              }}
            />
            <div
              ref={editorRef}
              className={dragOver ? "note-editor drag-over" : "note-editor"}
              contentEditable
              suppressContentEditableWarning
              onPaste={onPaste}
              onInput={() => setDirty(true)}
              onKeyUp={syncFmt}
              onMouseUp={syncFmt}
              {...dndProps}
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

      <Modal
        centered
        open={archiveOpen}
        onCancel={() => setArchiveOpen(false)}
        onOk={archive}
        title="归档笔记"
        okText="归档"
        cancelText="取消"
        width={400}
        confirmLoading={archiving}
      >
        <p className="page-meta" style={{ marginBottom: "var(--s2)" }}>
          归档后移入「归档区」，不再出现在活跃笔记列表；可随时还原。
        </p>
        <Input
          placeholder="学生名 / 备注（可空，归档区可搜索）"
          value={legacyNameDraft}
          maxLength={64}
          onChange={(e) => setLegacyNameDraft(e.target.value)}
        />
      </Modal>
    </div>
  );
}
