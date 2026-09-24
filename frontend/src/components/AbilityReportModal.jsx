import { useEffect, useRef, useState } from "react";
import { App as AntApp, Button, DatePicker, Input, InputNumber, Modal } from "antd";
import { apiGet, apiPost } from "../api";
import { ABILITY_DIMS } from "../utils/ability";
import { clientLog } from "../utils/clientLog";

// 能力报告生成弹窗：选范围 → 任务制轮询（ESA 60s 免疫）→ 草稿编辑定稿 → 存档。
// 草稿不落库（AI 起草、人定稿铁律）；tags/evidence 只读，文本与分数可改。

function toDay(v) {
  return v ? v.format("YYYY-MM-DD") : "";
}

export default function AbilityReportModal({ open, onClose, studentId, onSaved }) {
  const { message } = AntApp.useApp();
  const [range, setRange] = useState(null); // [dayjs, dayjs] | null = 全部历史
  const [estimate, setEstimate] = useState(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [recvChars, setRecvChars] = useState(0);
  const [draft, setDraft] = useState(null); // AI 草稿（含 range/assignment_count/usage）
  const [saving, setSaving] = useState(false);
  const abortRef = useRef(null);
  const timerRef = useRef(null);

  // 预估卡片：打开与范围变化时拉取（纯本地聚合，毫秒级）
  useEffect(() => {
    if (!open || draft) return undefined;
    const t = setTimeout(() => {
      apiPost("/ai/ability-report/estimate", {
        student_id: Number(studentId),
        range_start: toDay(range?.[0]),
        range_end: toDay(range?.[1]),
      })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, 350);
    return () => clearTimeout(t);
  }, [open, range, draft, studentId]);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      clearInterval(timerRef.current);
      setRunning(false);
      setDraft(null);
      setRange(null);
      setEstimate(null);
      setElapsed(0);
      setRecvChars(0);
    }
    return () => {
      abortRef.current?.abort();
      clearInterval(timerRef.current);
    };
  }, [open]);

  async function generate() {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setElapsed(0);
    setRecvChars(0);
    const started = Date.now();
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    clientLog.add("ui", `report_generate student=${studentId}`);
    try {
      const { job_id: jobId } = await apiPost("/ai/ability-report", {
        student_id: Number(studentId),
        range_start: toDay(range?.[0]),
        range_end: toDay(range?.[1]),
      });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        if (controller.signal.aborted) return;
        const job = await apiGet(`/ai/ability-jobs/${jobId}`);
        if (job.recv_chars != null) setRecvChars(job.recv_chars);
        if (job.status === "done") {
          clientLog.add("ui", `report_job_done student=${studentId} ${job.elapsed}s`);
          setDraft(job.data);
          break;
        }
        if (job.status === "error") throw new Error(job.error || "分析失败");
      }
    } catch (e) {
      if (e.name !== "AbortError") message.error(e.message);
    } finally {
      clearInterval(timerRef.current);
      setRunning(false);
    }
  }

  function patchDim(key, patch) {
    setDraft((d) => ({
      ...d,
      dimensions: d.dimensions.map((dim) => (dim.key === key ? { ...dim, ...patch } : dim)),
      scores: patch.score != null ? { ...d.scores, [key]: patch.score } : d.scores,
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await apiPost(`/students/${studentId}/ability-reports`, {
        range_start: draft.range_start || "",
        range_end: draft.range_end || "",
        assignment_count: draft.assignment_count || 0,
        overall: draft.overall,
        suggestions: draft.suggestions,
        dimensions: draft.dimensions,
        prompt_tokens: draft.prompt_tokens || 0,
        completion_tokens: draft.completion_tokens || 0,
        elapsed_seconds: draft.elapsed_seconds || 0,
      });
      clientLog.add("ui", `report_save student=${studentId} report=${saved.id}`);
      message.success("报告已存档");
      onSaved(saved);
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
      onCancel={() => {
        abortRef.current?.abort();
        onClose();
      }}
      footer={null}
      width={860}
      title={draft ? "能力报告草稿 · 编辑定稿" : "生成能力报告"}
      maskClosable={!running}
      destroyOnHidden
    >
      {!draft && (
        <div className="report-gen">
          <div className="report-gen-range">
            <span>数据范围</span>
            <DatePicker.RangePicker
              value={range}
              onChange={(v) => setRange(v)}
              allowClear
              placeholder={["起始日期", "截止日期"]}
            />
            <span className="report-gen-hint">留空 = 全部历史</span>
          </div>
          {estimate && (
            <div className="report-est">
              <div className="report-est-row">
                <span className="report-est-k">数据量</span>
                <span>
                  {estimate.assignment_count} 次作业 · 材料 {estimate.evidence_chars.toLocaleString()} 字符
                </span>
              </div>
              <div className="report-est-row">
                <span className="report-est-k">预估消耗</span>
                <span>
                  输入约 {estimate.est_prompt_tokens.toLocaleString()} + 输出约{" "}
                  {estimate.est_output_tokens.toLocaleString()} tokens
                </span>
              </div>
              <div className="report-est-row">
                <span className="report-est-k">预估费用</span>
                <span>
                  ¥{estimate.est_cost_yuan.toFixed(4)}（{estimate.price_tier === "offpeak" ? "谷时价" : "峰时价"}）
                </span>
              </div>
              <div className="report-est-row">
                <span className="report-est-k">预估时长</span>
                <span>约 2 ~ 6 分钟（推理模型，视数据量）</span>
              </div>
              {!estimate.has_data && (
                <div className="report-est-row report-est-warn">该范围内没有作业数据，无法生成报告</div>
              )}
            </div>
          )}
          <div className="report-gen-actions">
            <Button
              type="primary"
              loading={running}
              disabled={estimate !== null && !estimate.has_data}
              onClick={generate}
            >
              {running
                ? `分析中 · 已用 ${elapsed} 秒${recvChars > 0 ? ` · 已接收 ${recvChars.toLocaleString()} 字符` : ""}`
                : "开始分析"}
            </Button>
          </div>
        </div>
      )}

      {draft && (
        <div className="report-draft">
          {(draft.prompt_tokens > 0 || draft.elapsed_seconds > 0) && (
            <div className="report-est">
              <div className="report-est-row">
                <span className="report-est-k">实际消耗</span>
                <span>
                  输入 {(draft.prompt_tokens || 0).toLocaleString()} + 输出{" "}
                  {(draft.completion_tokens || 0).toLocaleString()} tokens · 用时{" "}
                  {Math.floor((draft.elapsed_seconds || 0) / 60)} 分 {(draft.elapsed_seconds || 0) % 60} 秒
                </span>
              </div>
            </div>
          )}
          <div className="report-draft-block">
            <div className="report-draft-label">总评</div>
            <Input.TextArea
              value={draft.overall}
              onChange={(e) => setDraft((d) => ({ ...d, overall: e.target.value }))}
              autoSize={{ minRows: 3 }}
            />
          </div>

          {ABILITY_DIMS.map((meta) => {
            const dim = draft.dimensions.find((d) => d.key === meta.key) || {};
            return (
              <div className="report-draft-block" key={meta.key}>
                <div className="report-draft-label report-draft-dimhead">
                  <span>{meta.label}</span>
                  <InputNumber
                    min={0}
                    max={100}
                    value={dim.score}
                    onChange={(v) => patchDim(meta.key, { score: v ?? 0 })}
                    size="small"
                  />
                </div>
                {dim.tags?.length > 0 && (
                  <div className="report-tags">
                    {dim.tags.map((t) => (
                      <span className="report-tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <Input.TextArea
                  value={dim.analysis}
                  onChange={(e) => patchDim(meta.key, { analysis: e.target.value })}
                  autoSize={{ minRows: 2 }}
                />
                {dim.evidence?.length > 0 && (
                  <div className="report-evs">
                    {dim.evidence.map((ev, i) => (
                      <blockquote className="report-ev" key={i}>
                        <div className="report-ev-quote">{ev.quote}</div>
                        <div className="report-ev-src">{ev.source}</div>
                      </blockquote>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className="report-draft-block">
            <div className="report-draft-label">教学建议</div>
            <Input.TextArea
              value={draft.suggestions}
              onChange={(e) => setDraft((d) => ({ ...d, suggestions: e.target.value }))}
              autoSize={{ minRows: 3 }}
            />
          </div>

          <div className="report-gen-actions">
            <Button onClick={() => setDraft(null)}>重新生成</Button>
            <Button type="primary" loading={saving} onClick={save}>
              确认存档
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
