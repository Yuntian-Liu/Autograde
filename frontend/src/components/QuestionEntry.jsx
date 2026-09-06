import { useEffect, useState } from "react";
import { App as AntApp, AutoComplete, Input, InputNumber, Modal, Select } from "antd";
import { apiPost } from "../api";
import { MODE_LABELS } from "../meta";

const MODE_OPTIONS = Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }));

function emptyRow(sections) {
  return {
    section: sections[0] || "",
    seq: null, // 交给后端按板块顺延
    stem: "",
    standard_answer: "",
    explanation: "",
    mode: "verbatim",
    score_weight: 5,
  };
}

// 验收表格：每行可改答案/权重/模式/删行，手工录入与 AI 草稿共用
function RowsEditor({ rows, setRows, sections }) {
  const sectionOptions = sections.map((s) => ({ value: s }));

  function patch(idx, field, value) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }

  return (
    <div>
      {rows.map((r, idx) => (
        <div className="qrow" key={idx}>
          <div className="qrow-head">
            <AutoComplete
              className="grow"
              value={r.section}
              options={sectionOptions}
              onChange={(v) => patch(idx, "section", v)}
              placeholder="板块名，如 Task 1 · Vocabulary"
            />
            <InputNumber
              min={1}
              value={r.seq}
              onChange={(v) => patch(idx, "seq", v)}
              placeholder="题号"
            />
            <Select
              value={r.mode}
              onChange={(v) => patch(idx, "mode", v)}
              options={MODE_OPTIONS}
              style={{ width: 110 }}
            />
            <InputNumber
              min={0.5}
              step={0.5}
              value={r.score_weight}
              onChange={(v) => patch(idx, "score_weight", v)}
              addonBefore="权重"
            />
            <button
              className="btn"
              onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
            >
              删行
            </button>
          </div>
          <Input
            value={r.stem}
            onChange={(e) => patch(idx, "stem", e.target.value)}
            placeholder="题干（可空）"
          />
          <Input
            value={r.standard_answer}
            onChange={(e) => patch(idx, "standard_answer", e.target.value)}
            placeholder="标准答案"
          />
          <Input
            value={r.explanation}
            onChange={(e) => patch(idx, "explanation", e.target.value)}
            placeholder="解析原文（可空）"
          />
        </div>
      ))}
      <button className="btn" onClick={() => setRows((prev) => [...prev, emptyRow(sections)])}>
        + 添加一行
      </button>
    </div>
  );
}

async function freezeQuestions(assignmentId, rows) {
  const payload = rows.map((r) => ({ ...r, seq: r.seq ?? undefined }));
  return apiPost(`/assignments/${assignmentId}/questions`, { questions: payload });
}

function validateRows(rows) {
  if (rows.length === 0) return "题目列表不能为空";
  for (const [i, r] of rows.entries()) {
    if (!r.section.trim()) return `第 ${i + 1} 行缺少板块名`;
    if (!r.standard_answer.trim()) return `第 ${i + 1} 行缺少标准答案`;
  }
  return null;
}

export function ManualEntryModal({ open, onClose, assignmentId, sections, onSaved }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setRows([emptyRow(sections)]);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    const error = validateRows(rows);
    if (error) return message.error(error);
    setSaving(true);
    try {
      await freezeQuestions(assignmentId, rows);
      message.success(`已冻结入库 ${rows.length} 题`);
      onSaved();
      onClose();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      confirmLoading={saving}
      title="录题"
      okText="冻结入库"
      cancelText="取消"
      width={720}
      destroyOnHidden
    >
      <RowsEditor rows={rows} setRows={setRows} sections={sections} />
    </Modal>
  );
}

export function AiEntryModal({ open, onClose, assignmentId, sections, onSaved }) {
  const { message } = AntApp.useApp();
  const [rawText, setRawText] = useState("");
  const [rows, setRows] = useState(null); // null = 还在粘贴阶段
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setRawText("");
      setRows(null);
    }
  }, [open]);

  async function parse() {
    if (!rawText.trim()) return message.error("请先粘贴答案原文");
    setParsing(true);
    try {
      const draft = await apiPost("/ai/parse-questions", {
        raw_text: rawText,
        assignment_id: Number(assignmentId),
      });
      const flat = (draft.sections || []).flatMap((sec) =>
        (sec.questions || []).map((q) => ({
          section: sec.section || "",
          seq: q.seq ?? null,
          stem: q.stem || "",
          standard_answer: q.standard_answer || "",
          explanation: q.explanation || "",
          mode: MODE_LABELS[q.mode] ? q.mode : "verbatim",
          score_weight: q.score_weight ?? 5,
        }))
      );
      if (flat.length === 0) {
        message.error("AI 未拆出任何题目，请检查粘贴内容");
        return;
      }
      setRows(flat);
    } catch (e) {
      message.error(e.message);
    } finally {
      setParsing(false);
    }
  }

  async function freeze() {
    const error = validateRows(rows);
    if (error) return message.error(error);
    setSaving(true);
    try {
      await freezeQuestions(assignmentId, rows);
      message.success(`已冻结入库 ${rows.length} 题`);
      onSaved();
      onClose();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="AI 录题"
      width={720}
      destroyOnHidden
      footer={
        rows === null ? (
          <>
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" onClick={parse} disabled={parsing}>
              {parsing ? "解析中…" : "AI 拆分"}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setRows(null)}>
              返回重贴
            </button>
            <button className="btn primary" onClick={freeze} disabled={saving}>
              {saving ? "入库中…" : `确认冻结（${rows.length} 题）`}
            </button>
          </>
        )
      }
    >
      {rows === null ? (
        <Input.TextArea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={12}
          placeholder="粘贴从机构 PDF / Word 转换的答案原文，AI 会剔除水印并按板块拆成题目草稿"
        />
      ) : (
        <RowsEditor rows={rows} setRows={setRows} sections={sections} />
      )}
    </Modal>
  );
}
