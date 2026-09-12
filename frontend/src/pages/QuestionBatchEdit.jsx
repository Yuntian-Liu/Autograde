import { IconChevronLeft } from "../components/icons";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { App as AntApp } from "antd";
import { apiGet, apiPut } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { SectionsEditor, groupRows, optionsFromText, validateRows } from "../components/QuestionEntry";
import { seriesLabel } from "../meta";

// 整批编辑页：把题库拉回验收表格（行带 id），保存走 PUT 整批 diff——
// 已有题更新（id 不变，错题/批改引用全保）、新行插入、消失的行删除（级联错题记录）；
// 板块卡上下移的结果作为 section_order 一并保存
export default function QuestionBatchEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [assignment, setAssignment] = useState(null);
  const [rows, setRows] = useState(null);
  const [originalIds, setOriginalIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    apiGet(`/assignments/${id}`)
      .then((a) => {
        setAssignment(a);
        const flat = (a.sections || []).flatMap((sec) =>
          (sec.questions || []).map((q) => ({
            id: q.id,
            section: sec.section,
            seq: q.seq,
            stem: q.stem || "",
            optionsText: (q.options || []).join("\n"),
            standard_answer: q.standard_answer || "",
            explanation: q.explanation || "",
            mode: q.mode,
            score_weight: q.score_weight,
          }))
        );
        setRows(flat);
        setOriginalIds(flat.map((r) => r.id));
      })
      .catch((e) => setError(e.message));
  }, [id]);

  // diff 摘要：改多少（id 保留数）/ 增多少 / 删多少——保存前让用户看清后果
  const diff = useMemo(() => {
    if (!rows) return { updated: 0, inserted: 0, removed: 0 };
    const kept = rows.filter((r) => r.id).length;
    return {
      updated: kept,
      inserted: rows.length - kept,
      removed: originalIds.filter((oid) => !rows.some((r) => r.id === oid)).length,
    };
  }, [rows, originalIds]);

  async function save() {
    const err = validateRows(rows);
    if (err) return message.error(err);
    setSaving(true);
    try {
      const sectionOrder = groupRows(rows).map((g) => g.section);
      const res = await apiPut(`/assignments/${id}/questions`, {
        questions: rows.map((r) => ({
          id: r.id ?? undefined,
          section: r.section,
          seq: r.seq ?? undefined,
          mode: r.mode,
          stem: r.stem,
          options: optionsFromText(r.optionsText),
          standard_answer: r.standard_answer,
          explanation: r.explanation,
          score_weight: r.score_weight,
        })),
        section_order: sectionOrder,
      });
      message.success(`已保存：改 ${res.updated} · 增 ${res.inserted} · 删 ${res.removed}`);
      navigate(`/assignments/${id}`);
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (error)
    return (
      <div className="page-enter">
        <div className="page-error">加载失败：{error}</div>
      </div>
    );
  if (!assignment || !rows)
    return (
      <div className="page-enter">
        <PageSkeleton />
      </div>
    );

  const c = assignment.class;

  return (
    <div className="page-enter">
      <AppHeader
        crumbs={[
          { label: "工作台", to: "/" },
          ...(c ? [{ label: `${seriesLabel(c.series)} ${c.name}`, to: `/classes/${c.id}` }] : []),
          { label: `${assignment.unit_label} ${assignment.content}`.trim(), to: `/assignments/${assignment.slug || assignment.id}` },
          { label: "整批编辑" },
        ]}
      />
      <div className="wrap">
        <Link className="back" to={`/assignments/${id}`}>
          <IconChevronLeft />返回批次
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>整批编辑</h1>
        <div className="page-meta">
          {assignment.unit_label} {assignment.content} · 共 {rows.length} 题 · 已有题保留编号，
          批改引用不受影响
        </div>

        {/* 常驻工具栏：diff 摘要 + 保存 */}
        <div className="batch-toolbar">
          <span className="batch-diff">
            保留 {diff.updated} · 新增 <b className="tone-good">{diff.inserted}</b> · 删除{" "}
            <b className={diff.removed > 0 ? "tone-bad" : ""}>{diff.removed}</b>
            {diff.removed > 0 && <span className="tone-bad">（将连带删除对应错题记录）</span>}
          </span>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存全部"}
          </button>
        </div>

        <SectionsEditor rows={rows} setRows={setRows} sections={[]} movable />
      </div>
    </div>
  );
}
