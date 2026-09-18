import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { App as AntApp, Input, Segmented, Select } from "antd";
import { apiGet, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import { clientLog } from "../utils/clientLog";
import { serializeEditor } from "../utils/noteFormat";
import { useNotePaste } from "../utils/useNotePaste";

// 批量导入：一张大表一次录入多份笔记。关联学生行落活跃区；历史行进归档区（带学生名/备注）。
// 内容区支持图文粘贴——图片先走 tmp key 直传 COS，提交后由后端对账归属到正式笔记。

let rowSeq = 0;
const newRow = () => ({
  key: ++rowSeq,
  mode: "link", // link=关联学生 | legacy=历史归档
  class_id: null,
  student_id: null,
  assignment_id: null,
  legacy_name: "",
  title: "",
  status: "idle", // idle | ok | fail
  noteId: null,
  error: "",
});

function ImportRow({ row, classes, classDetails, ensureClassDetail, onChange, onRemove, registerEditor, disabled }) {
  const editorRef = useRef(null);
  const { onPaste, dndProps, uploading, migrating, dragOver } = useNotePaste({
    editorRef,
    noteId: null, // 未创建先贴图：tmp key，提交后后端对账
    onDirty: () => {},
  });
  const detail = row.class_id ? classDetails[row.class_id] : null;
  // 编辑器 DOM 上报给父级：提交时逐行 serialize
  const setEditorEl = (el) => {
    editorRef.current = el;
    registerEditor(row.key, el);
  };

  return (
    <div className={`import-row ${row.status}`}>
      <div className="import-row-head">
        <Segmented
          size="small"
          value={row.mode}
          disabled={disabled}
          onChange={(v) => onChange({ ...row, mode: v })}
          options={[
            { value: "link", label: "关联学生" },
            { value: "legacy", label: "历史归档" },
          ]}
        />
        {row.mode === "link" ? (
          <>
            <Select
              size="small"
              style={{ minWidth: 130 }}
              placeholder="班级"
              allowClear
              disabled={disabled}
              value={row.class_id}
              options={classes.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(v) => {
                onChange({ ...row, class_id: v ?? null, student_id: null, assignment_id: null });
                if (v) ensureClassDetail(v);
              }}
            />
            <Select
              size="small"
              style={{ minWidth: 120 }}
              placeholder="学生"
              allowClear
              disabled={disabled || !row.class_id}
              value={row.student_id}
              options={(detail?.students || []).map((s) => ({ value: s.id, label: s.name }))}
              onChange={(v) => onChange({ ...row, student_id: v ?? null })}
            />
            <Select
              size="small"
              style={{ minWidth: 150 }}
              placeholder="批次（可空）"
              allowClear
              disabled={disabled || !row.class_id}
              value={row.assignment_id}
              options={(detail?.assignments || []).map((a) => ({ value: a.id, label: a.unit_label }))}
              onChange={(v) => onChange({ ...row, assignment_id: v ?? null })}
            />
          </>
        ) : (
          <Input
            size="small"
            style={{ maxWidth: 220 }}
            placeholder="学生名 / 备注（可空，归档可搜）"
            disabled={disabled}
            value={row.legacy_name}
            maxLength={64}
            onChange={(e) => onChange({ ...row, legacy_name: e.target.value })}
          />
        )}
        <span className="import-row-status">
          {row.status === "ok" && (
            <span className="ok">
              已导入 · <Link to={`/notes/${row.noteId}`}>查看</Link>
            </span>
          )}
          {row.status === "fail" && <span className="fail">{row.error}</span>}
        </span>
        <button
          type="button"
          className="btn danger sm"
          disabled={disabled}
          onClick={onRemove}
          title="删除该行"
        >
          删除
        </button>
      </div>
      <Input
        size="small"
        placeholder="标题（可空，留空取正文首行）"
        disabled={disabled}
        value={row.title}
        maxLength={128}
        onChange={(e) => onChange({ ...row, title: e.target.value })}
      />
      <div
        ref={setEditorEl}
        className={dragOver ? "note-editor mini drag-over" : "note-editor mini"}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onPaste={onPaste}
        {...dndProps}
      />
      {(uploading > 0 || migrating) && (
        <div className="page-meta">{migrating || "图片上传中…"}</div>
      )}
    </div>
  );
}

export default function NoteImport() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState([newRow()]);
  const [classes, setClasses] = useState([]);
  const [classDetails, setClassDetails] = useState({}); // classId → {students, assignments}（行间共享缓存）
  const [submitting, setSubmitting] = useState(false);
  const editorsRef = useRef({}); // row.key → 编辑器 DOM

  useEffect(() => {
    apiGet("/classes").then(setClasses).catch(() => {});
  }, []);

  function ensureClassDetail(classId) {
    if (classDetails[classId]) return;
    apiGet(`/classes/${classId}`)
      .then((d) => setClassDetails((prev) => ({ ...prev, [classId]: d })))
      .catch(() => {});
  }

  const patchRow = (key, next) => setRows((prev) => prev.map((r) => (r.key === key ? next : r)));

  async function submitAll() {
    // 逐行序列化，收集有效行（内容为空且未成功的行跳过）
    const pending = [];
    const nextRows = rows.map((r) => ({ ...r }));
    for (const r of nextRows) {
      if (r.status === "ok") continue;
      const ed = editorsRef.current[r.key];
      const content = ed ? serializeEditor(ed) : "";
      if (!content.trim() && !r.title.trim()) continue;
      pending.push({ row: r, content });
    }
    if (pending.length === 0) return message.warning("没有可导入的行（内容为空）");
    setSubmitting(true);
    try {
      const res = await apiPost("/notes/bulk", {
        items: pending.map(({ row, content }) => ({
          content,
          title: row.title.trim() || null,
          class_id: row.mode === "link" ? row.class_id : null,
          student_id: row.mode === "link" ? row.student_id : null,
          assignment_id: row.mode === "link" ? row.assignment_id : null,
          archived: row.mode === "legacy",
          legacy_name: row.mode === "legacy" ? row.legacy_name.trim() : "",
        })),
      });
      // 后端按 items 下标回报成败，映射回行
      const idxToRow = pending.map((p) => p.row.key);
      const byIndex = new Map();
      for (const c of res.created) byIndex.set(c.index, { status: "ok", noteId: c.id, error: "" });
      for (const f of res.failed) byIndex.set(f.index, { status: "fail", noteId: null, error: f.error });
      setRows((prev) =>
        prev.map((r) => {
          const pendingIdx = idxToRow.indexOf(r.key);
          if (pendingIdx === -1) return r;
          const outcome = byIndex.get(pendingIdx);
          return outcome ? { ...r, ...outcome } : r;
        })
      );
      clientLog.add(
        "ui",
        `批量导入笔记：成功 ${res.created.length} 行，失败 ${res.failed.length} 行`
      );
      if (res.failed.length === 0) message.success(`全部导入成功（${res.created.length} 篇）`);
      else message.warning(`成功 ${res.created.length} 篇，失败 ${res.failed.length} 篇（见行内提示）`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  const okCount = rows.filter((r) => r.status === "ok").length;

  return (
    <div className="page-enter">
      <AppHeader crumbs={[{ label: "工作台", to: "/" }, { label: "笔记库", to: "/notes" }, { label: "批量导入" }]} />
      <div className="wrap">
        <Link className="back" to="/notes">
          ← 笔记库
        </Link>
        <h1 className="page-title" style={{ marginTop: "var(--s3)" }}>
          批量导入笔记
        </h1>
        <p className="page-meta" style={{ marginTop: "var(--s1)" }}>
          每行一篇：关联学生落活跃区，历史归档落归档区。内容支持直接粘贴图文。
        </p>

        <div style={{ marginTop: "var(--s4)", display: "grid", gap: "var(--s3)" }}>
          {rows.map((r) => (
            <ImportRow
              key={r.key}
              row={r}
              classes={classes}
              classDetails={classDetails}
              ensureClassDetail={ensureClassDetail}
              disabled={submitting || r.status === "ok"}
              onChange={(next) => patchRow(r.key, next)}
              onRemove={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
              registerEditor={(key, el) => {
                if (el) editorsRef.current[key] = el;
                else delete editorsRef.current[key];
              }}
            />
          ))}
        </div>

        <div className="btn-row" style={{ marginTop: "var(--s4)" }}>
          <button className="btn" disabled={submitting} onClick={() => setRows((p) => [...p, newRow()])}>
            + 添加一行
          </button>
          <button className="btn primary" disabled={submitting} onClick={submitAll}>
            {submitting ? "导入中…" : `全部导入${okCount ? `（已成功 ${okCount} 行不重交）` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
