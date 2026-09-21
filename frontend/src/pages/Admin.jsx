import { IconChevronLeft } from "../components/icons";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { App as AntApp, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Table, Tabs } from "antd";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminApi, apiDelete, apiGet, apiPost, apiPut, downloadBackup } from "../api";
import AppHeader from "../components/AppHeader";
import PageSkeleton from "../components/PageSkeleton";
import { RATING_THRESHOLDS } from "../rating";
import { fmtBytes, fmtTime } from "../meta";
import { useAuth } from "../contexts/AuthContext";
import { clientLog } from "../utils/clientLog";
import { fp } from "../utils/contentfp";

// 管理后台（仅 is_admin 可达，路由已守卫；此处再判一次防御深度）
const WINDOWS = [
  { label: "今日", value: "today" },
  { label: "7 天", value: "7d" },
  { label: "30 天", value: "30d" },
  { label: "全部", value: "all" },
];

function Metric({ label, value, sub, danger, tone }) {
  return (
    <div className="metric-card">
      <div className="k">{label}</div>
      <div className={`v ${danger ? "tone-bad" : tone === "good" ? "tone-good" : tone === "accent" ? "tone-accent" : tone === "warn" ? "tone-mid" : ""}`}>{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

// 面板失败态：错误说明 + 重试（替代永久卡在「加载中…」）
function PanelError({ onRetry }) {
  return (
    <div className="page-error">
      加载失败
      <button className="btn" style={{ marginLeft: "var(--s3)" }} onClick={onRetry}>
        重试
      </button>
    </div>
  );
}

export default function Admin() {
  const { user } = useAuth();
  if (!user?.is_admin) return <div className="page-enter"><div className="page-error">无权限</div></div>;
  return (
    <div className="page-enter">
      <AppHeader crumbs={[{ label: "工作台", to: "/" }, { label: "管理后台" }]} />
      <div className="wrap">
        <Link className="back" to="/"><IconChevronLeft />工作台</Link>
        <h1 style={{ marginTop: "var(--s3)" }}>管理后台</h1>
        <Tabs
          defaultActiveKey="overview"
          items={[
            { key: "overview", label: "总览", children: <OverviewPanel /> },
            { key: "ai", label: "AI 用量", children: <AiPanel /> },
            { key: "phrases", label: "话术", children: <PhrasesPanel /> },
            { key: "rating", label: "评级", children: <RatingPanel /> },
            { key: "invites", label: "邀请码", children: <InvitesPanel /> },
            { key: "security", label: "安全", children: <SecurityPanel /> },
            { key: "data", label: "数据", children: <DataPanel /> },
          ]}
        />
      </div>
    </div>
  );
}

/* ---------- 总览 ---------- */
function LookupCard() {
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null); // {ok, data} | {ok:false, error}
  const [busy, setBusy] = useState(false);

  async function search() {
    if (!code.trim() || busy) return;
    setBusy(true);
    setResult(null);
    try {
      setResult({ ok: true, data: await adminApi.lookup(code.trim()) });
    } catch (e) {
      setResult({ ok: false, error: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="block">
      <div className="sec-title">编码速查</div>
      <div className="notes-toolbar">
        <Input
          placeholder="输入业务编码，如 202603-W51-S00042-7"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onPressEnter={search}
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="btn primary" onClick={search} disabled={busy}>
          {busy ? "查询中…" : "查询"}
        </button>
      </div>
      {result?.ok && (
        <div className="settings-row static" style={{ marginTop: "var(--s2)" }}>
          <span>
            {result.data.type === "student" ? "学生" : "批次"} · {result.data.label}（
            {result.data.class_name}）
          </span>
          <span className="settings-value">
            归属 UID {result.data.owner_uid}
            {result.data.owner_nickname ? `（${result.data.owner_nickname}）` : ""} ·{" "}
            <Link to={result.data.web_path}>跳转</Link>
          </span>
        </div>
      )}
      {result && !result.ok && (
        <div className="settings-row static" style={{ marginTop: "var(--s2)" }}>
          <span className="tone-bad">{result.error}</span>
        </div>
      )}
    </section>
  );
}

function OverviewPanel() {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    setData(null);
    adminApi.overview().then(setData).catch(() => setData({ error: true }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <div className="admin-loading">加载中…</div>;
  if (data.error) return <PanelError onRetry={load} />;
  return (
    <div>
      <div className="metric-grid">
        <Metric label="用户" value={data.users} />
        <Metric label="班级" value={data.classes} />
        <Metric label="批次" value={data.assignments} />
        <Metric label="学生" value={data.students} />
        <Metric label="已批改提交" value={data.graded} tone="good" />
        <Metric label="今日 AI 成本" value={`¥${Number(data.ai_cost_today_yuan).toFixed(4)}`} tone="accent" sub={data.ai_cost_today_yuan > 1 ? "偏高，留意用量" : ""} danger={data.ai_cost_today_yuan > 1} />
        <Metric label="数据库" value={`${data.db_size_mb} MB`} />
        <Metric label="版本" value={data.version} />
      </div>
      <LookupCard />
    </div>
  );
}

/* ---------- AI 用量（峰谷定价） ---------- */

// 峰时段行校验：HH:MM、有效时段、不重叠（跨午夜展开，照 Stellaris validateWindows）
function validateWindows(windows) {
  const spans = [];
  for (const [s, e] of windows) {
    const m1 = /^(\d{1,2}):(\d{2})$/.exec(s || "");
    const m2 = /^(\d{1,2}):(\d{2})$/.exec(e || "");
    if (!m1 || !m2) return "时段格式应为 HH:MM（如 09:00）";
    const sv = +m1[1] * 60 + +m1[2];
    const ev = +m2[1] * 60 + +m2[2];
    if (sv >= 1440 || ev > 1440 || sv === ev) return `时段无效：${s}-${e}`;
    spans.push(...(sv < ev ? [[sv, ev]] : [[sv, 1440], [0, ev]])); // 跨午夜展开
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] < spans[i - 1][1]) return "峰时段存在重叠，请调整";
  }
  return null;
}

function TierTag({ tier }) {
  if (tier === "peak") return <span className="tier-peak">峰</span>;
  if (tier === "offpeak") return <span className="tier-offpeak">谷</span>;
  return <span className="tier-none">—</span>;
}

function AiPanel() {
  const { message } = AntApp.useApp();
  const [win, setWin] = useState("7d");
  const [data, setData] = useState(null);
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceForm, setPriceForm] = useState({
    price_input: 4,
    price_output: 12,
    price_cache_hit: 0.5,
    offpeak_input: 1,
    offpeak_output: 4,
    offpeak_cache_hit: 0.25,
    peak_windows: [["09:00", "12:00"], ["14:00", "18:00"]],
    weekend_rule: "all_offpeak",
  });

  const load = useCallback(() => {
    setData(null);
    adminApi.aiUsage(win).then(setData).catch(() => setData({ error: true }));
  }, [win]);

  useEffect(() => {
    load();
  }, [load]);

  function openPrices() {
    adminApi
      .getPrices()
      .then((r) => {
        setPriceForm({
          price_input: r.prices.price_input,
          price_output: r.prices.price_output,
          price_cache_hit: r.prices.price_cache_hit,
          offpeak_input: r.prices.offpeak_input,
          offpeak_output: r.prices.offpeak_output,
          offpeak_cache_hit: r.prices.offpeak_cache_hit,
          peak_windows: (r.prices.peak_windows || []).map((w) => [...w]),
          weekend_rule: r.prices.weekend_rule || "all_offpeak",
        });
        setPriceOpen(true);
      })
      .catch((e) => message.error(e.message));
  }

  async function savePrices() {
    const err = validateWindows(priceForm.peak_windows || []);
    if (err) return message.error(err);
    try {
      await adminApi.setPrices(priceForm);
      message.success("峰谷定价已更新（只影响之后的调用）");
      setPriceOpen(false);
      load();
    } catch (e) {
      message.error(e.message);
    }
  }

  function patchWindow(i, j, v) {
    const ws = priceForm.peak_windows.map((w, idx) => (idx === i ? w.map((x, k) => (k === j ? v : x)) : w));
    setPriceForm({ ...priceForm, peak_windows: ws });
  }

  if (!data) return <div className="admin-loading">加载中…</div>;
  if (data.error) return <PanelError onRetry={load} />;
  const s = data.summary;

  return (
    <div>
      <div className="admin-toolbar">
        <Segmented options={WINDOWS} value={win} onChange={setWin} />
        <button className="btn" onClick={openPrices}>峰谷定价</button>
      </div>
      <div className="metric-grid">
        <Metric label="调用次数" value={s.calls} sub={`失败 ${s.failed} · 空回答 ${s.empty}`} />
        <Metric label="输入 tokens" value={s.prompt_tokens?.toLocaleString?.() ?? s.prompt_tokens} />
        <Metric label="输出 tokens" value={s.completion_tokens?.toLocaleString?.() ?? s.completion_tokens} />
        <Metric label="总成本" value={`¥${Number(s.cost_yuan).toFixed(4)}`} tone="accent" />
        <Metric label="峰时成本" value={`¥${Number(s.peak_cost ?? 0).toFixed(4)}`} tone="warn" />
        <Metric label="谷时成本" value={`¥${Number(s.offpeak_cost ?? 0).toFixed(4)}`} tone="good" />
      </div>

      {data.by_day.length > 0 && (
        <section className="block">
          <div className="sec-title">按天成本（峰 / 谷 堆叠，元）</div>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={data.by_day}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={60} />
                <Tooltip formatter={(v, name) => [`¥${Number(v).toFixed(4)}`, name === "peak_cost" ? "峰时" : name === "offpeak_cost" ? "谷时" : "未标注"]} />
                <Bar dataKey="peak_cost" stackId="cost" fill="var(--warning)" />
                <Bar dataKey="offpeak_cost" stackId="cost" fill="var(--success)" radius={[3, 3, 0, 0]} />
                <Bar dataKey="untagged_cost" stackId="cost" fill="var(--accent)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="block">
        <div className="sec-title">按批次</div>
        <Table
          size="small"
          rowKey="assignment_id"
          pagination={{ pageSize: 10 }}
          dataSource={data.by_assignment}
          columns={[
            { title: "批次", render: (_, r) => `${r.label}（${r.class_name}）` },
            { title: "调用", dataIndex: "calls", width: 80 },
            { title: "tokens", dataIndex: "tokens", width: 120,
              render: (v) => Number(v ?? 0).toLocaleString() },
            { title: "成本", dataIndex: "cost", width: 110,
              render: (v) => `¥${Number(v).toFixed(4)}` },
          ]}
        />
      </section>

      <section className="block">
        <div className="sec-title">最近调用</div>
        <Table
          size="small"
          rowKey="id"
          pagination={{ pageSize: 10 }}
          dataSource={data.recent}
          columns={[
            { title: "时间", dataIndex: "created_at", width: 170,
              render: (v) => (v ? fmtTime(v) : "—") },
            { title: "功能", dataIndex: "feature", width: 130 },
            { title: "峰谷", dataIndex: "price_tier", width: 60,
              render: (v) => <TierTag tier={v} /> },
            { title: "输入", dataIndex: "prompt_tokens", width: 90 },
            { title: "输出", dataIndex: "completion_tokens", width: 90 },
            { title: "成本", dataIndex: "cost_yuan", width: 100,
              render: (v) => `¥${Number(v).toFixed(4)}` },
            { title: "状态", width: 110, render: (_, r) => {
              if (!r.finish_reason) return <span className="tone-bad">调用异常</span>;
              if (r.is_empty) return <span className="tone-mid">空回答</span>;
              if (r.finish_reason === "parse_error") return <span className="tone-mid">解析失败</span>;
              return <span className="tone-good">正常</span>;
            } },
          ]}
        />
      </section>

      <Modal
        centered
        open={priceOpen}
        onCancel={() => setPriceOpen(false)}
        onOk={savePrices}
        title="峰谷定价（元 / 百万 tokens，北京时间时段）"
        okText="保存"
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <div className="price-grid">
          <div className="price-group">
            <div className="price-group-title tier-peak">峰时单价</div>
            <div className="form-grid">
              <span className="flab">输入</span>
              <InputNumber min={0} step={0.5} value={priceForm.price_input}
                onChange={(v) => setPriceForm({ ...priceForm, price_input: v })} style={{ width: "100%" }} />
              <span className="flab">输入（缓存命中）</span>
              <InputNumber min={0} step={0.25} value={priceForm.price_cache_hit}
                onChange={(v) => setPriceForm({ ...priceForm, price_cache_hit: v })} style={{ width: "100%" }} />
              <span className="flab">输出</span>
              <InputNumber min={0} step={0.5} value={priceForm.price_output}
                onChange={(v) => setPriceForm({ ...priceForm, price_output: v })} style={{ width: "100%" }} />
            </div>
          </div>
          <div className="price-group">
            <div className="price-group-title tier-offpeak">谷时单价</div>
            <div className="form-grid">
              <span className="flab">输入</span>
              <InputNumber min={0} step={0.5} value={priceForm.offpeak_input}
                onChange={(v) => setPriceForm({ ...priceForm, offpeak_input: v })} style={{ width: "100%" }} />
              <span className="flab">输入（缓存命中）</span>
              <InputNumber min={0} step={0.25} value={priceForm.offpeak_cache_hit}
                onChange={(v) => setPriceForm({ ...priceForm, offpeak_cache_hit: v })} style={{ width: "100%" }} />
              <span className="flab">输出</span>
              <InputNumber min={0} step={0.5} value={priceForm.offpeak_output}
                onChange={(v) => setPriceForm({ ...priceForm, offpeak_output: v })} style={{ width: "100%" }} />
            </div>
          </div>
        </div>
        <div className="price-windows">
          <div className="price-group-title">峰时段（北京时间）</div>
          {priceForm.peak_windows.map((w, i) => (
            <div className="price-window-row" key={i}>
              <Input size="small" value={w[0]} placeholder="09:00" style={{ width: 90 }}
                onChange={(e) => patchWindow(i, 0, e.target.value)} />
              <span>至</span>
              <Input size="small" value={w[1]} placeholder="12:00" style={{ width: 90 }}
                onChange={(e) => patchWindow(i, 1, e.target.value)} />
              <button type="button" className="btn"
                onClick={() => setPriceForm({ ...priceForm, peak_windows: priceForm.peak_windows.filter((_, idx) => idx !== i) })}>
                删除
              </button>
            </div>
          ))}
          <button type="button" className="btn"
            onClick={() => setPriceForm({ ...priceForm, peak_windows: [...priceForm.peak_windows, ["", ""]] })}>
            + 添加时段
          </button>
          <div className="price-weekend">
            周末规则：
            <Select size="small" value={priceForm.weekend_rule} style={{ width: 140 }}
              onChange={(v) => setPriceForm({ ...priceForm, weekend_rule: v })}
              options={[
                { value: "all_offpeak", label: "周末全谷" },
                { value: "same", label: "周末同工作日" },
              ]} />
          </div>
        </div>
        <p className="login-hint">改价只影响之后的调用；历史成本按调用当时的单价结算，不回溯。</p>
      </Modal>
    </div>
  );
}

/* ---------- 话术管理 ---------- */
const PHRASE_CATEGORIES = ["问候语·早上", "问候语·中午", "问候语·下午", "问候语·晚上", "评级话术", "Issue 模板", "催交"];

function PhrasesPanel() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState(null);
  const [category, setCategory] = useState(null);
  const [editing, setEditing] = useState(null); // null=关；{} = 新增；{id...} = 编辑
  const [form, setForm] = useState({ category: "", name: "", content: "", format: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    setRows(null);
    apiGet(`/phrases${q}`)
      .then(setRows)
      .catch(() => setRows({ error: true }));
  }, [category]);

  useEffect(() => {
    load();
  }, [load]);

  function openNew() {
    setForm({ category: category || "Issue 模板", name: "", content: "", format: "" });
    setEditing({});
  }

  function openEdit(row) {
    setForm({ category: row.category, name: row.name, content: row.content, format: row.format || "" });
    setEditing(row);
  }

  async function save() {
    if (!form.category.trim() || !form.content.trim())
      return message.error("分类与内容不能为空");
    setSaving(true);
    try {
      if (editing.id) {
        await apiPut(`/phrases/${editing.id}`, form);
      } else {
        await apiPost("/phrases", form);
      }
      clientLog.add(
        "ui",
        editing.id
          ? `编辑话术 #${editing.id} len=${form.content.length} fp=${fp(form.content)}`
          : `新增话术（${form.category}）len=${form.content.length} fp=${fp(form.content)}`
      );
      message.success(editing.id ? "话术已更新" : "话术已新增");
      setEditing(null);
      load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(row) {
    try {
      await apiDelete(`/phrases/${row.id}`);
      message.success("已删除");
      load();
    } catch (e) {
      message.error(e.message);
    }
  }

  if (!rows) return <div className="admin-loading">加载中…</div>;
  if (rows.error) return <PanelError onRetry={load} />;

  return (
    <div>
      <div className="admin-toolbar">
        <Select
          allowClear
          placeholder="全部分类"
          value={category}
          onChange={setCategory}
          style={{ width: 180 }}
          options={PHRASE_CATEGORIES.map((c) => ({ value: c, label: c }))}
        />
        <button className="btn" onClick={openNew}>+ 新增话术</button>
      </div>
      <Table
        size="small"
        rowKey="id"
        pagination={{ pageSize: 15 }}
        dataSource={rows}
        columns={[
          { title: "分类", dataIndex: "category", width: 130 },
          { title: "条目", dataIndex: "name", width: 110, render: (v) => v || "—" },
          { title: "内容", dataIndex: "content", ellipsis: true },
          { title: "来源", dataIndex: "scope", width: 80 },
          { title: "使用", dataIndex: "use_count", width: 70,
            render: (v) => Number(v ?? 0).toLocaleString() },
          { title: "操作", width: 130, render: (_, row) => (
            <>
              <button className="btn" onClick={() => openEdit(row)}>编辑</button>
              {row.scope !== "内置" && (
                <Popconfirm title="删除该话术？" okText="删除" cancelText="取消"
                  onConfirm={() => remove(row)}>
                  <button className="btn danger">删除</button>
                </Popconfirm>
              )}
            </>
          ) },
        ]}
      />

      <Modal
        centered
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={save}
        confirmLoading={saving}
        title={editing?.id ? "编辑话术" : "新增话术"}
        okText="保存"
        cancelText="取消"
        width={520}
        destroyOnHidden
      >
        <div className="form-grid">
          <span className="flab">分类</span>
          <Select value={form.category} style={{ width: "100%" }}
            onChange={(v) => setForm({ ...form, category: v })}
            options={[...PHRASE_CATEGORIES, ...(form.category && !PHRASE_CATEGORIES.includes(form.category) ? [form.category] : [])].map((c) => ({ value: c, label: c }))}
            showSearch />
          <span className="flab">条目名</span>
          <Input value={form.name} maxLength={64}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Issue 模板/评级话术的档位名" />
          <span className="flab">内容</span>
          <Input.TextArea value={form.content} autoSize={{ minRows: 3, maxRows: 8 }}
            onChange={(e) => setForm({ ...form, content: e.target.value })} />
          <span className="flab">格式</span>
          <Select value={form.format} style={{ width: "100%" }}
            onChange={(v) => setForm({ ...form, format: v })}
            options={[
              { value: "", label: "纯文本" },
              { value: "title_bold", label: "标题加粗（首行）" },
              { value: "title_bold+body_italic", label: "标题加粗 + 正文倾斜" },
            ]} />
        </div>
      </Modal>
    </div>
  );
}

/* ---------- 邀请码 ---------- */
const STATUS_COLOR = { 可用: "tone-good", 已用完: "tone-mid", 已过期: "tone-mid", 已作废: "tone-bad" };

function InvitesPanel() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState(null);
  const [genOpen, setGenOpen] = useState(false);
  const [gen, setGen] = useState({ count: 1, valid_days: 30, max_uses: 1, note: "" });
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setRows(null);
    adminApi.inviteCodes().then(setRows).catch(() => setRows({ error: true }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setCreating(true);
    try {
      const made = await adminApi.createInvites(gen);
      message.success(`已生成 ${made.length} 个邀请码`);
      setGenOpen(false);
      load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id) {
    try {
      await adminApi.revokeInvite(id);
      message.success("已作废");
      load();
    } catch (e) {
      message.error(e.message);
    }
  }

  if (!rows) return <div className="admin-loading">加载中…</div>;
  if (rows.error) return <PanelError onRetry={load} />;

  return (
    <div>
      <div className="admin-toolbar">
        <button className="btn" onClick={() => setGenOpen(true)}>+ 生成邀请码</button>
      </div>
      <Table
        size="small"
        rowKey="id"
        pagination={{ pageSize: 15 }}
        dataSource={rows}
        columns={[
          { title: "邀请码", dataIndex: "code", width: 150,
            render: (v) => <span className="mono">{v}</span> },
          { title: "状态", dataIndex: "status", width: 90,
            render: (v) => <span className={STATUS_COLOR[v] || ""}>{v}</span> },
          { title: "使用", width: 90,
            render: (_, r) => `${r.use_count} / ${r.max_uses}${r.used_by ? `（UID ${r.used_by}）` : ""}` },
          { title: "有效期至", dataIndex: "expires_at", width: 170,
            render: (v) => (v ? fmtTime(v).slice(0, 10) : "永不过期") },
          { title: "备注", dataIndex: "note", ellipsis: true },
          { title: "操作", width: 90, render: (_, row) =>
            row.status === "可用" ? (
              <Popconfirm title="作废该邀请码？" okText="作废" cancelText="取消"
                onConfirm={() => revoke(row.id)}>
                <button className="btn danger">作废</button>
              </Popconfirm>
            ) : null },
        ]}
      />

      <Modal
        centered
        open={genOpen}
        onCancel={() => setGenOpen(false)}
        onOk={create}
        confirmLoading={creating}
        title="生成邀请码"
        okText="生成"
        cancelText="取消"
        width={420}
        destroyOnHidden
      >
        <div className="form-grid">
          <span className="flab">数量</span>
          <InputNumber min={1} max={20} value={gen.count}
            onChange={(v) => setGen({ ...gen, count: v })} style={{ width: "100%" }} />
          <span className="flab">有效期（天）</span>
          <InputNumber min={1} max={365} value={gen.valid_days}
            onChange={(v) => setGen({ ...gen, valid_days: v })} style={{ width: "100%" }} />
          <span className="flab">每码可用次数</span>
          <InputNumber min={1} max={100} value={gen.max_uses}
            onChange={(v) => setGen({ ...gen, max_uses: v })} style={{ width: "100%" }} />
          <span className="flab">备注</span>
          <Input value={gen.note} maxLength={100}
            onChange={(e) => setGen({ ...gen, note: e.target.value })}
            placeholder="给谁发的" />
        </div>
      </Modal>
    </div>
  );
}

/* ---------- 安全 ---------- */
function SecurityPanel() {
  const [data, setData] = useState(null);
  const load = useCallback(() => {
    setData(null);
    adminApi.security().then(setData).catch(() => setData({ error: true }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <div className="admin-loading">加载中…</div>;
  if (data.error) return <PanelError onRetry={load} />;
  const keyRows = [
    ["JWT 密钥", data.keys.jwt_secret_set],
    ["邮件发信（Resend）", data.keys.resend_set],
    ["AI 服务 Key", data.keys.openai_key_set],
    ["生产模式", data.keys.is_prod],
  ];
  return (
    <div>
      <div className="metric-grid">
        <Metric label="登录限流拦截（本次运行）" value={data.login_blocked_count} danger={data.login_blocked_count > 0} />
      </div>
      <section className="block">
        <div className="sec-title">密钥与配置</div>
        {keyRows.map(([k, ok]) => (
          <div className="settings-row static" key={k}>
            <span>{k}</span>
            <span className={`settings-value ${ok ? "tone-good" : "tone-bad"}`}>
              {ok ? "已配置" : "未配置"}
            </span>
          </div>
        ))}
      </section>
      <section className="block">
        <div className="sec-title">安全事件</div>
        {data.login_blocked_events.length === 0 ? (
          <div className="row">暂无事件</div>
        ) : (
          data.login_blocked_events.map((e, i) => (
            <div className="row" key={i}>
              <span className="mono">{e.time}</span>
              <span className="row-name">{e.detail}</span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

/* ---------- 数据管理 ---------- */
/* ---------- 评级分数线 ---------- */
function RatingPanel() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState(null); // [{rating, min}] 按档位高低序
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setRows(null);
    apiGet("/rating-thresholds")
      .then((t) => setRows(t.map((x) => ({ rating: x.rating, min: x.min }))))
      .catch(() => setRows({ error: true }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // 前端先拦一道（后端仍会校验）：范围 0-100、严格递减、F 固定 0
  function validate() {
    for (const r of rows) {
      if (r.min < 0 || r.min > 100) return "分数线必须在 0-100 之间";
    }
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].min <= rows[i + 1].min) return "分数线必须按档位严格递减";
    }
    if (rows[rows.length - 1].min !== 0) return "F 档分数线固定为 0";
    return null;
  }

  async function save() {
    const err = validate();
    if (err) return message.error(err);
    setSaving(true);
    try {
      await apiPut("/admin/rating-thresholds", { thresholds: rows });
      clientLog.add("ui", `评级分数线更新 fp=${fp(JSON.stringify(rows))}`);
      message.success("分数线已保存，即刻生效");
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (rows?.error) return <PanelError onRetry={load} />;
  if (!rows) return <PageSkeleton />;
  return (
    <section className="block">
      <div className="sec-title sec-title-row">
        十二档分数线（左闭右开）
        <span>
          <button
            className="btn sm"
            disabled={saving}
            onClick={() => setRows(RATING_THRESHOLDS.map(([rating, min]) => ({ rating, min })))}
          >
            恢复默认
          </button>{" "}
          <button className="btn primary sm" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </span>
      </div>
      <div className="row">
        改线后实时计算的页面立即按新线显示；已落库的历史等级不变（等级是保存时刻算好存库的）。
      </div>
      {rows.map((r, i) => (
        <div className="settings-row static" key={r.rating}>
          <span>{r.rating}</span>
          <span className="settings-value">
            ≥{" "}
            <InputNumber
              size="small"
              min={0}
              max={100}
              step={0.5}
              disabled={r.rating === "F"}
              value={r.min}
              onChange={(v) =>
                setRows((prev) => prev.map((x, j) => (j === i ? { ...x, min: v ?? 0 } : x)))
              }
            />
          </span>
        </div>
      ))}
    </section>
  );
}

function DataPanel() {
  const { message } = AntApp.useApp();
  const [overview, setOverview] = useState(null);
  const [cos, setCos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState(null); // COS 备份列表（null=加载中）
  const [cosBusy, setCosBusy] = useState(false);
  const [orphans, setOrphans] = useState(null); // 孤儿图片扫描结果 {count, bytes} | null
  const [gcBusy, setGcBusy] = useState(false);
  const load = useCallback(() => {
    setOverview(null);
    adminApi.overview().then(setOverview).catch(() => setOverview({ error: true }));
    apiGet("/admin/cos-usage").then(setCos).catch(() => setCos(null));
    apiGet("/admin/backups").then(setBackups).catch(() => setBackups(null));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function backup() {
    setBusy(true);
    try {
      await downloadBackup();
      message.success("备份已下载");
    } catch (e) {
      message.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function backupToCos() {
    setCosBusy(true);
    try {
      const r = await apiPost("/admin/backups", {});
      clientLog.add("ui", `手动备份到 COS：${r.key}（${r.size}B）`);
      message.success("已备份到对象存储");
      apiGet("/admin/backups").then(setBackups).catch(() => {});
    } catch (e) {
      message.error(e.message);
    } finally {
      setCosBusy(false);
    }
  }

  async function downloadCosBackup(key) {
    try {
      const r = await apiGet(`/admin/backups/download?key=${encodeURIComponent(key)}`);
      window.open(r.url, "_blank");
    } catch (e) {
      message.error(e.message);
    }
  }

  // 备份 key 含东八区时间戳（backups/autograde-20260919-013000.db），直接解析展示
  const fmtBackupKey = (key) => {
    const m = key.match(/autograde-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/);
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : key;
  };

  // 桶内与库内一致性：偏差 >1MB 视为不一致（tmp 未对账的临时件允许小差）
  const bucketPulled = cos?.bucket_bytes !== null && cos?.bucket_bytes !== undefined;
  const bucketMismatch = bucketPulled && Math.abs(cos.bucket_bytes - cos.db_bytes) > 1024 * 1024;

  // 最新备份新鲜度（东八区时间戳在 key 里，本机同时区直接构造）：≤24h 绿、≤72h 黄、更久红
  const latestBackupKey = backups?.[0]?.key || null;
  const backupAgeHours = (() => {
    const m = latestBackupKey?.match(/autograde-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/);
    if (!m) return null;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    return (Date.now() - t) / 3.6e6;
  })();
  const backupTone =
    backupAgeHours === null ? "" : backupAgeHours <= 24 ? "tone-good" : backupAgeHours <= 72 ? "tone-mid" : "tone-bad";
  const backupAgeText =
    backupAgeHours === null ? "" : backupAgeHours < 1 ? "1 小时内" : backupAgeHours < 24 ? `${Math.floor(backupAgeHours)} 小时前` : `${Math.floor(backupAgeHours / 24)} 天前`;

  async function scanOrphans() {
    setGcBusy(true);
    try {
      setOrphans(await apiGet("/admin/orphan-images"));
    } catch (e) {
      message.error(e.message);
    } finally {
      setGcBusy(false);
    }
  }

  async function cleanupOrphans() {
    setGcBusy(true);
    try {
      const r = await apiPost("/admin/orphan-images/cleanup", {});
      clientLog.add("ui", `孤儿图片清理：删除 ${r.deleted} 个（${r.freed_bytes}B）`);
      message.success(`已清理 ${r.deleted} 个未引用图片`);
      setOrphans(null);
      load();
    } catch (e) {
      message.error(e.message);
    } finally {
      setGcBusy(false);
    }
  }

  return (
    <div>
      {overview?.error ? (
        <PanelError onRetry={load} />
      ) : (
      <div className="metric-grid">
        <Metric
          label="图片存储（COS）"
          tone="accent"
          value={cos ? `${(cos.db_bytes / 1024 / 1024).toFixed(1)} MB` : "…"}
          sub={cos ? `${cos.db_images} 张` : ""}
        />
        <Metric label="数据库大小" value={overview ? `${overview.db_size_mb} MB` : "…"} />
        <Metric label="版本" value={overview?.version ?? "…"} />
      </div>
      )}
      <section className="block">
        <div className="sec-title">对象存储（COS）</div>
        <div className="settings-row static">
          <span>配置状态</span>
          <span className={`settings-value ${cos?.cos_set ? "tone-good" : "tone-bad"}`}>
            {cos ? (cos.cos_set ? "已配置" : "未配置") : "…"}
          </span>
        </div>
        <div className="settings-row static">
          <span>库内追踪图片</span>
          <span className="settings-value">
            {cos ? `${cos.db_images} 张 · ${(cos.db_bytes / 1024 / 1024).toFixed(1)} MB` : "…"}
          </span>
        </div>
        {cos?.cos_set && (
          <div className="settings-row static">
            <span>桶内实际对象（notes/ 前缀）</span>
            <span
              className={`settings-value ${bucketPulled ? (bucketMismatch ? "tone-mid" : "tone-good") : "tone-bad"}`}
            >
              {cos.bucket_objects === null
                ? "拉取失败（仅显库内数）"
                : `${cos.bucket_objects} 个 · ${(cos.bucket_bytes / 1024 / 1024).toFixed(1)} MB${bucketMismatch ? " · 与库内不一致" : ""}`}
            </span>
          </div>
        )}
        {cos?.cos_set && (
          <div className="settings-row static">
            <span>未引用图片（孤儿）</span>
            <span className={`settings-value ${orphans ? (orphans.count > 0 ? "tone-mid" : "tone-good") : ""}`}>
              {orphans ? `${orphans.count} 个 · ${fmtBytes(orphans.bytes)}` : "未扫描"}{" "}
              <button className="btn sm" onClick={scanOrphans} disabled={gcBusy}>
                扫描
              </button>{" "}
              {orphans && orphans.count > 0 && (
                <Popconfirm
                  title={`确认删除 ${orphans.count} 个未引用图片？`}
                  description={
                    <span>
                      只清理 <span className="tone-mid">7 天前</span> 上传且任何笔记都未引用的对象，此操作不可恢复
                    </span>
                  }
                  onConfirm={cleanupOrphans}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                >
                  <button className="btn sm danger">清理</button>
                </Popconfirm>
              )}
            </span>
          </div>
        )}
      </section>
      <section className="block">
        <div className="sec-title sec-title-row">
          备份
          <button className="btn primary" onClick={backup} disabled={busy}>
            {busy ? "备份中…" : "下载备份"}
          </button>
        </div>
        <div className="row">
          在线快照导出完整 SQLite 数据库（含账号、班级、批改与 AI 用量流水），建议每次重要批改周期后下载留存。
        </div>
      </section>
      <section className="block">
        <div className="sec-title sec-title-row">
          对象存储备份
          <button
            className="btn primary"
            onClick={backupToCos}
            disabled={cosBusy || cos?.cos_set === false}
          >
            {cosBusy ? "备份中…" : "立即备份"}
          </button>
        </div>
        <div className="row">
          <span>
            每日自动备份（最新备份超 <span className="tone-mid">24 小时</span>自动补一份，保留最近 <span className="tone-mid">30 份</span>）。恢复为手动操作：下载备份文件，停服替换数据库后重启。
          </span>
        </div>
        {backups !== null && backups.length > 0 && (
          <div className="settings-row static">
            <span>最新备份</span>
            <span className={`settings-value ${backupTone}`}>
              {fmtBackupKey(latestBackupKey)} · {backupAgeText}
              {backupAgeHours > 24 ? "（偏旧，留意自动备份是否正常）" : ""}
            </span>
          </div>
        )}
        {backups === null ? (
          <div className="row">加载中…</div>
        ) : backups.length === 0 ? (
          <div className="row">暂无备份</div>
        ) : (
          backups.map((b) => (
            <div className="settings-row static" key={b.key}>
              <span>{fmtBackupKey(b.key)}</span>
              <span className="settings-value">
                {fmtBytes(b.size)} ·{" "}
                <button className="btn sm" onClick={() => downloadCosBackup(b.key)}>
                  下载
                </button>
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
