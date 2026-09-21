import { useEffect, useRef, useState } from "react";
import { Link, useBlocker } from "react-router-dom";
import { App as AntApp, Input, Segmented, Select } from "antd";
import { apiGet, apiPost } from "../api";
import AppHeader from "../components/AppHeader";
import { clientLog } from "../utils/clientLog";
import { serializeEditor, seriesFromTitle, studentNameFromTitle, unitFromTitle } from "../utils/noteFormat";
import { useNotePaste } from "../utils/useNotePaste";

// 批量导入：一张大表一次录入多份笔记。关联学生行落活跃区；历史行进归档区（带学生名/备注）。
// 内容区支持图文粘贴——图片先走 tmp key 直传 COS，提交后由后端对账归属到正式笔记。

let rowSeq = 0;
// 新行默认跟随触发行的模式（归档连着录就一直是归档，切了关联就跟着关联）
const newRow = (mode = "link") => ({
  key: ++rowSeq,
  mode, // link=关联学生 | legacy=历史归档
  class_id: null,
  student_id: null,
  assignment_id: null,
  legacy_name: "",
  nameEdited: false, // 手动改过名字后不再自动提取（自动提取只填空白）
  linkEdited: false, // 手动改过班级/学生后不再自动锁定
  detectedName: "", // 标题抽出的学生名（link 行自动锁定用）
  detectedSeries: "", // 标题反馈类型反推的系列（NG/WW，空=不限）
  detectedUnit: "", // 标题抽出的单元进度（归一化，自动锁批次用）
  title: "",
  touched: false, // 有任何内容即 true（末尾未触碰行渲染为占位样式）
  status: "idle", // idle | ok | fail
  noteId: null,
  error: "",
});

function ImportRow({ row, index, collapsed, summary, onExpand, onFocusRow, isPlaceholder, classes, classDetails, ensureClassDetail, onChange, onRemove, registerEditor, onTouch, disabled }) {
  const editorRef = useRef(null);
  // 内容首行标题自动识别：归档行抽学生名预填备注；关联行抽名字+系列供父级锁定班级/学生
  // 手动改过（nameEdited/linkEdited）后不再自动覆盖
  const autoDetect = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const text = ed.innerText || "";
    if (row.mode === "legacy") {
      if (row.nameEdited) return;
      const name = studentNameFromTitle(text);
      if (name && name !== row.legacy_name) onChange({ ...row, legacy_name: name });
    } else if (!row.linkEdited) {
      const name = studentNameFromTitle(text);
      const series = seriesFromTitle(text);
      const unit = unitFromTitle(text);
      if (name && (name !== row.detectedName || series !== row.detectedSeries || unit !== row.detectedUnit)) {
        onChange({ ...row, detectedName: name, detectedSeries: series, detectedUnit: unit });
      }
    }
  };
  const { onPaste, dndProps, uploading, migrating, dragOver } = useNotePaste({
    editorRef,
    noteId: null, // 未创建先贴图：tmp key，提交后后端对账
    onDirty: () => {
      onFocusRow(); // 粘贴进本行也算焦点落到本行（右键粘贴不触发 focus）
      onTouch();
      autoDetect();
    },
  });
  const detail = row.class_id ? classDetails[row.class_id] : null;
  // 编辑器 DOM 上报给父级：提交时逐行 serialize
  const setEditorEl = (el) => {
    editorRef.current = el;
    registerEditor(row.key, el);
  };

  return (
    <div className={`import-row ${row.status}${isPlaceholder ? " placeholder" : ""}${collapsed ? " collapsed" : ""}`}>
      {collapsed ? (
        // 折叠态：一行摘要（编号 + 首行 + 状态），点击展开；下方编辑器 display:none 保 DOM 不丢内容
        <div className="import-row-summary" onClick={onExpand}>
          <span className="row-seq">#{index + 1}</span>
          <span className="summary-text">{summary || "（无内容）"}</span>
          {row.status === "ok" && <span className="ok">已导入</span>}
          {row.status === "fail" && <span className="fail">{row.error}</span>}
          {row.status === "idle" && (
            <span className="hint">{row.mode === "legacy" ? "归档" : "关联"} · 点击展开</span>
          )}
        </div>
      ) : (
        <>
          <div className="import-row-head">
            <span className="row-seq">#{index + 1}</span>
            <Segmented
              size="small"
              value={row.mode}
              disabled={disabled}
              onChange={(v) => {
                // 切到归档时若名字还空着且没手动改过，立即从已贴内容提取一次；切到关联同理先抽名字+系列
                const text = editorRef.current?.innerText || "";
                const name = studentNameFromTitle(text);
                const extra = {};
                if (v === "legacy" && !row.nameEdited && !row.legacy_name && name) extra.legacy_name = name;
                if (v === "link" && !row.linkEdited && name) {
                  extra.detectedName = name;
                  extra.detectedSeries = seriesFromTitle(text);
                  extra.detectedUnit = unitFromTitle(text);
                }
                onChange({ ...row, mode: v, ...extra });
              }}
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
                    onChange({ ...row, class_id: v ?? null, student_id: null, assignment_id: null, linkEdited: true });
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
                  onChange={(v) => onChange({ ...row, student_id: v ?? null, linkEdited: true })}
                />
                <Select
                  size="small"
                  style={{ minWidth: 150 }}
                  placeholder="批次（可空）"
                  allowClear
                  disabled={disabled || !row.class_id}
                  value={row.assignment_id}
                  options={(detail?.assignments || []).map((a) => ({ value: a.id, label: a.unit_label }))}
                  onChange={(v) => onChange({ ...row, assignment_id: v ?? null, linkEdited: true })}
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
                onChange={(e) => onChange({ ...row, legacy_name: e.target.value, nameEdited: true })}
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
        </>
      )}
      {/* 编辑器常驻（折叠仅视觉隐藏）：contentEditable 内容在 DOM 里，卸载即丢 */}
      <div className="editor-wrap" style={collapsed ? { display: "none" } : undefined}>
        <div
          ref={setEditorEl}
          className={dragOver ? "note-editor mini drag-over" : "note-editor mini"}
          contentEditable={!disabled && !collapsed}
          suppressContentEditableWarning
          onPaste={onPaste}
          onFocus={onFocusRow}
          onInput={() => {
            onTouch();
            autoDetect();
          }}
          {...dndProps}
        />
        {(uploading > 0 || migrating) && (
          <div className="page-meta">{migrating || "图片上传中…"}</div>
        )}
      </div>
    </div>
  );
}

export default function NoteImport() {
  const { message, modal } = AntApp.useApp();
  const [rows, setRows] = useState([newRow()]);
  const [classes, setClasses] = useState([]);
  const [classDetails, setClassDetails] = useState({}); // classId → {students, assignments}（行间共享缓存）
  const [submitting, setSubmitting] = useState(false);
  // 折叠时机：只在焦点落到另一行（点击/粘贴进别的行）时才收起上一行——
  // 绝不在「自动续行」瞬间切，否则正在输入的编辑器被 display:none，后续按键丢失
  const [activeKey, setActiveKey] = useState(null); // 当前展开编辑的行；其余已填行折叠成摘要
  const editorsRef = useRef({}); // row.key → 编辑器 DOM

  useEffect(() => {
    apiGet("/classes").then(setClasses).catch(() => {});
  }, []);

  const okCount = rows.filter((r) => r.status === "ok").length;
  const filledCount = rows.filter((r) => r.touched).length;

  // 防丢：有已填但未导入的行时，离开页面二次确认（路由拦截 + 关标签/刷新）
  const blocking = filledCount > okCount;
  const blocker = useBlocker(blocking);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    modal.confirm({
      title: "有未导入的内容",
      content: "确定离开？已填写但未导入的行将丢失。",
      okText: "离开",
      cancelText: "继续录入",
      centered: true,
      okButtonProps: { danger: true },
      onOk: () => blocker.proceed(),
      onCancel: () => blocker.reset(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);
  useEffect(() => {
    if (!blocking) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [blocking]);

  function ensureClassDetail(classId) {
    if (classDetails[classId]) return;
    apiGet(`/classes/${classId}`)
      .then((d) => setClassDetails((prev) => ({ ...prev, [classId]: d })))
      .catch(() => {});
  }

  const patchRow = (key, next) => setRows((prev) => prev.map((r) => (r.key === key ? next : r)));

  // 关联行自动锁定：detectedName + detectedSeries → 全班级范围精确匹配学生，唯一命中才自动选
  // （同名多人不猜，保持手动）；学生锁定后再按 detectedUnit 在该班批次里锁批次（唯一命中才选）；
  // classDetails 异步到位后本 effect 自动补解析
  useEffect(() => {
    for (const r of rows) {
      if (r.mode !== "link" || r.linkEdited || !r.detectedName) continue;
      let classId = r.class_id;
      let studentId = r.student_id;
      if (!classId || !studentId) {
        const want = r.detectedName.trim().toLowerCase();
        const matches = [];
        let waiting = false;
        for (const c of classes) {
          if (r.detectedSeries && c.series !== r.detectedSeries) continue;
          const d = classDetails[c.id];
          if (!d) {
            ensureClassDetail(c.id);
            waiting = true;
            continue;
          }
          for (const s of d.students || []) {
            if (s.name.trim().toLowerCase() === want) matches.push({ c, s });
          }
        }
        if (waiting) continue; // 数据没拉齐，等下一轮
        if (matches.length !== 1) continue; // 查无此人/同名多人不猜
        classId = matches[0].c.id;
        studentId = matches[0].s.id;
      }
      // 批次：单元进度在已锁定班级内唯一命中才自动选
      let assignmentId = r.assignment_id;
      if (classId && !assignmentId && r.detectedUnit) {
        const d = classDetails[classId];
        if (!d) {
          ensureClassDetail(classId);
          continue;
        }
        const am = (d.assignments || []).filter(
          (x) => (x.unit_label || "").replace(/\s+/g, "") === r.detectedUnit
        );
        if (am.length === 1) assignmentId = am[0].id;
      }
      if (classId !== r.class_id || studentId !== r.student_id || assignmentId !== r.assignment_id) {
        patchRow(r.key, { ...r, class_id: classId, student_id: studentId, assignment_id: assignmentId });
      }
    }
  }, [rows, classDetails, classes]); // eslint-disable-line react-hooks/exhaustive-deps

  // 表格始终留一行空行：最后一行有任何内容即在末尾补新空行；行带 touched 标记（末尾未触碰行渲染为占位样式）
  function touchRow(key) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.key === key);
      if (idx === -1) return prev;
      const r = prev[idx];
      const ed = editorsRef.current[r.key];
      const hasContent = Boolean(ed && (ed.textContent.trim() || ed.querySelector("img")));
      const hasField = Boolean(r.title.trim() || r.legacy_name.trim() || r.class_id || r.student_id);
      const touched = hasField || hasContent;
      let next = prev.map((x) => (x.key === key ? { ...x, touched } : x));
      if (touched && idx === next.length - 1) next = [...next, newRow(next[idx].mode)]; // 续行继承本行模式
      return next;
    });
  }

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

  // 折叠摘要 = 身份标识（谁 + 第几单元），不取正文：优先手动标题，其次从首行抽名字+单元进度
  const rowSummary = (r) => {
    if (r.title.trim()) return r.title.trim();
    const ed = editorsRef.current[r.key];
    const text = ed?.innerText || "";
    const name =
      (r.mode === "legacy" ? r.legacy_name : r.detectedName) || studentNameFromTitle(text);
    const unit = r.detectedUnit || unitFromTitle(text);
    if (name && unit) return `${name} · ${unit}`;
    if (name) return name;
    return (text.split("\n").find((l) => l.trim()) || "").trim().slice(0, 30);
  };

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
          每行一篇：关联学生落活跃区，历史归档落归档区。内容支持直接粘贴图文；最后一行开始填写后会自动补新行，已填行自动折叠成摘要（点击可展开）。
        </p>

        <div style={{ marginTop: "var(--s4)", display: "grid", gap: "var(--s3)" }}>
          {rows.map((r, i) => (
            <ImportRow
              key={r.key}
              row={r}
              index={i}
              collapsed={r.touched && r.key !== activeKey}
              summary={rowSummary(r)}
              onExpand={() => setActiveKey(r.key)}
              onFocusRow={() => setActiveKey(r.key)}
              isPlaceholder={i === rows.length - 1 && !r.touched && r.status === "idle"}
              classes={classes}
              classDetails={classDetails}
              ensureClassDetail={ensureClassDetail}
              disabled={submitting || r.status === "ok"}
              onChange={(next) => {
                patchRow(r.key, next);
                touchRow(r.key);
              }}
              onRemove={() =>
                setRows((prev) => {
                  const next = prev.filter((x) => x.key !== r.key);
                  return next.length ? next : [newRow(r.mode)]; // 删光时保底一行空行（沿用本行模式）
                })
              }
              registerEditor={(key, el) => {
                if (el) editorsRef.current[key] = el;
                else delete editorsRef.current[key];
              }}
              onTouch={() => touchRow(r.key)}
            />
          ))}
        </div>

        <div className="btn-row" style={{ marginTop: "var(--s4)" }}>
          <button
            className="btn"
            disabled={submitting}
            onClick={() => setRows((p) => [...p, newRow(p[p.length - 1]?.mode || "link")])}
          >
            + 添加一行
          </button>
          <button className="btn primary" disabled={submitting} onClick={submitAll}>
            {submitting ? "导入中…" : `全部导入${okCount ? `（已成功 ${okCount} 行不重交）` : ""}`}
          </button>
        </div>

        {/* 悬浮操作条：长表单滚到下面也能提交/回顶部/返回（回顶部纯滚动，不碰表单内容） */}
        {filledCount > 0 && (
          <div className="import-dock">
            <span className="dock-info">
              已填 {filledCount} 篇{okCount > 0 ? ` · 已导入 ${okCount}` : ""}
            </span>
            <button className="btn primary sm" disabled={submitting} onClick={submitAll}>
              {submitting ? "导入中…" : "全部导入"}
            </button>
            <button
              className="btn sm"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            >
              回顶部
            </button>
            <Link className="btn sm" to="/notes">
              返回笔记库
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
