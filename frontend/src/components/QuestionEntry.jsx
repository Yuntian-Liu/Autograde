import { useEffect, useRef, useState } from "react";
import { App as AntApp, AutoComplete, Input, InputNumber, Modal, Select } from "antd";
import { apiPost, clearToken, getToken, UNAUTHORIZED_EVENT } from "../api";
import { MODE_LABELS } from "../meta";

const MODE_OPTIONS = Object.entries(MODE_LABELS).map(([value, label]) => ({ value, label }));

function emptyRow(section, weight = 5) {
  return {
    section,
    seq: null, // 交给后端按板块顺延
    stem: "",
    optionsText: "", // 一行一个选项，提交时转数组
    standard_answer: "",
    explanation: "",
    mode: "verbatim",
    score_weight: weight,
  };
}

function optionsFromText(text) {
  return (text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 按板块分组（保持首次出现顺序），返回 [{ section, indices }]
function groupRows(rows) {
  const groups = [];
  const byName = new Map();
  rows.forEach((row, idx) => {
    let g = byName.get(row.section);
    if (!g) {
      g = { section: row.section, indices: [] };
      byName.set(row.section, g);
      groups.push(g);
    }
    g.indices.push(idx);
  });
  return groups;
}

// 验收区：一个板块一张卡片，卡片头可编辑板块名 + 整组统一分值
function SectionsEditor({ rows, setRows, sections }) {
  const sectionOptions = sections.map((s) => ({ value: s }));
  const groups = groupRows(rows);

  function patchRow(idx, field, value) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }

  function patchGroup(indices, patch) {
    const inGroup = new Set(indices);
    setRows((prev) => prev.map((r, i) => (inGroup.has(i) ? { ...r, ...patch } : r)));
  }

  function removeGroup(indices) {
    const inGroup = new Set(indices);
    setRows((prev) => prev.filter((_, i) => !inGroup.has(i)));
  }

  function addRowTo(group) {
    const weight = rows[group.indices[0]]?.score_weight ?? 5;
    setRows((prev) => [...prev, emptyRow(group.section, weight)]);
  }

  return (
    <div>
      {groups.map((g) => {
        const first = rows[g.indices[0]];
        // key 用首行索引而非板块名：板块名一改就 remount 会导致输入框每敲一个字丢焦点
        return (
          <div className="sec-card" key={g.indices[0]}>
            <div className="sec-card-head">
              <AutoComplete
                className="grow"
                value={g.section}
                options={sectionOptions}
                onChange={(v) => patchGroup(g.indices, { section: v })}
                placeholder="板块名，如 Task 1 · Vocabulary"
              />
              <InputNumber
                min={0.5}
                step={0.5}
                value={first?.score_weight}
                onChange={(v) => patchGroup(g.indices, { score_weight: v })}
                addonBefore="统一分值"
              />
              <button className="btn" onClick={() => addRowTo(g)}>
                + 加题
              </button>
              <button className="btn" onClick={() => removeGroup(g.indices)}>
                删板块
              </button>
            </div>
            {g.indices.map((idx) => {
              const r = rows[idx];
              return (
                <div className="qrow" key={idx}>
                  <div className="qrow-head">
                    <InputNumber
                      min={1}
                      value={r.seq}
                      onChange={(v) => patchRow(idx, "seq", v)}
                      placeholder="题号"
                    />
                    <Select
                      value={r.mode}
                      onChange={(v) => patchRow(idx, "mode", v)}
                      options={MODE_OPTIONS}
                      style={{ width: 110 }}
                    />
                    <button
                      className="btn qrow-del"
                      onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      删行
                    </button>
                  </div>
                  <Input
                    value={r.stem}
                    onChange={(e) => patchRow(idx, "stem", e.target.value)}
                    placeholder="题干（可空）"
                  />
                  <Input.TextArea
                    value={r.optionsText}
                    onChange={(e) => patchRow(idx, "optionsText", e.target.value)}
                    placeholder={"选项（可空，一行一个）\nA. forest\nB. river"}
                    autoSize={{ minRows: 1, maxRows: 6 }}
                  />
                  <Input
                    value={r.standard_answer}
                    onChange={(e) => patchRow(idx, "standard_answer", e.target.value)}
                    placeholder="标准答案"
                  />
                  <Input.TextArea
                    value={r.explanation}
                    onChange={(e) => patchRow(idx, "explanation", e.target.value)}
                    placeholder="解析原文（可空，保留换行）"
                    autoSize={{ minRows: 1, maxRows: 6 }}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      <button className="btn" onClick={() => setRows((prev) => [...prev, emptyRow("")])}>
        + 添加板块
      </button>
    </div>
  );
}

async function freezeQuestions(assignmentId, rows) {
  const payload = rows.map((r) => ({
    section: r.section,
    seq: r.seq ?? undefined,
    mode: r.mode,
    stem: r.stem,
    options: optionsFromText(r.optionsText),
    standard_answer: r.standard_answer,
    explanation: r.explanation,
    score_weight: r.score_weight,
  }));
  return apiPost(`/assignments/${assignmentId}/questions`, { questions: payload });
}

function validateRows(rows) {
  if (rows.length === 0) return "题目列表不能为空";
  for (const [i, r] of rows.entries()) {
    if (!r.section.trim()) return `第 ${i + 1} 题缺少板块名`;
    if (!r.standard_answer.trim()) return `第 ${i + 1} 题缺少标准答案`;
  }
  return null;
}

export function ManualEntryModal({ open, onClose, assignmentId, sections, initialSection, onSaved }) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setRows([emptyRow(initialSection ?? sections[0] ?? "")]);
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
      centered
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
      <SectionsEditor rows={rows} setRows={setRows} sections={sections} />
    </Modal>
  );
}

function flattenDraft(draft) {
  return (draft.sections || []).flatMap((sec) =>
    (sec.questions || []).map((q) => ({
      section: sec.section || "",
      seq: q.seq ?? null,
      stem: q.stem || "",
      optionsText: Array.isArray(q.options) ? q.options.join("\n") : "",
      standard_answer: q.standard_answer || "",
      explanation: q.explanation || "",
      mode: MODE_LABELS[q.mode] ? q.mode : "verbatim",
      score_weight: q.score_weight ?? 5,
    }))
  );
}

export function AiEntryModal({ open, onClose, assignmentId, sections, onSaved }) {
  const { message } = AntApp.useApp();
  const [rawText, setRawText] = useState("");
  const [rows, setRows] = useState(null); // null = 还在粘贴阶段
  const [parsing, setParsing] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (open) {
      setRawText("");
      setRows(null);
      setDoneCount(0);
      setElapsed(0);
    }
    return () => {
      abortRef.current?.abort();
      clearInterval(timerRef.current);
    };
  }, [open]);

  // SSE：fetch + ReadableStream 逐事件读取，实时更新「已整理 N 题」
  async function parse() {
    if (!rawText.trim()) return message.error("请先粘贴答案原文");
    const controller = new AbortController();
    abortRef.current = controller;
    setParsing(true);
    setDoneCount(0);
    setElapsed(0);
    const started = Date.now();
    timerRef.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000
    );
    try {
      const token = getToken();
      const res = await fetch("/api/ai/parse-questions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ raw_text: rawText, assignment_id: Number(assignmentId) }),
        signal: controller.signal,
      });
      if (res.status === 401) {
        clearToken();
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
        throw new Error("登录已过期，请重新登录");
      }
      if (!res.ok || !res.body) {
        let detail = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body && body.detail) detail = body.detail;
        } catch {
          /* 保留状态码描述 */
        }
        throw new Error(detail);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let draft = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!chunk.startsWith("data:")) continue;
          const event = JSON.parse(chunk.slice(5).trim());
          if (event.type === "progress") setDoneCount(event.done);
          else if (event.type === "done") draft = event.data;
          else if (event.type === "error") throw new Error(event.detail);
        }
      }
      const flat = draft ? flattenDraft(draft) : [];
      if (flat.length === 0) {
        message.error("AI 未拆出任何题目，请检查粘贴内容");
        return;
      }
      setRows(flat);
    } catch (e) {
      if (e.name !== "AbortError") message.error(e.message);
    } finally {
      clearInterval(timerRef.current);
      setParsing(false);
    }
  }

  function cancel() {
    abortRef.current?.abort();
    onClose();
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
      centered
      open={open}
      onCancel={cancel}
      title="AI 录题"
      width={720}
      destroyOnHidden
      footer={
        rows === null ? (
          <div className="modal-actions">
            <button className="btn" onClick={cancel}>
              取消
            </button>
            <button className="btn primary" onClick={parse} disabled={parsing}>
              {parsing ? `正在解析 · 已整理 ${doneCount} 题` : "AI 拆分"}
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            <button className="btn" onClick={() => setRows(null)}>
              返回重贴
            </button>
            <button className="btn primary" onClick={freeze} disabled={saving}>
              {saving ? "入库中…" : `确认冻结（${rows.length} 题）`}
            </button>
          </div>
        )
      }
    >
      {rows === null ? (
        <>
          <Input.TextArea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={12}
            readOnly={parsing}
            placeholder="粘贴从机构 PDF / Word 转换的答案原文，AI 会剔除水印并按板块拆成题目草稿"
          />
          {parsing && (
            <div className="parse-progress">
              正在解析 · 已整理 {doneCount} 题 · {elapsed}s
            </div>
          )}
        </>
      ) : (
        <SectionsEditor rows={rows} setRows={setRows} sections={sections} />
      )}
    </Modal>
  );
}
