import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { App as AntApp, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Table, Tabs } from "antd";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { adminApi, apiDelete, apiGet, apiPost, apiPut, downloadBackup } from "../api";
import AppHeader from "../components/AppHeader";
import { useAuth } from "../contexts/AuthContext";

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
        <Link className="back" to="/">← 工作台</Link>
        <h1 style={{ marginTop: "var(--s3)" }}>管理后台</h1>
        <Tabs
          defaultActiveKey="overview"
          items={[
            { key: "overview", label: "总览", children: <OverviewPanel /> },
            { key: "ai", label: "AI 用量", children: <AiPanel /> },
            { key: "phrases", label: "话术", children: <PhrasesPanel /> },
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
              render: (v) => (v ? v.slice(0, 19).replace("T", " ") : "—") },
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
  const [form, setForm] = useState({ category: "", name: "", content: "" });
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
    setForm({ category: category || "Issue 模板", name: "", content: "" });
    setEditing({});
  }

  function openEdit(row) {
    setForm({ category: row.category, name: row.name, content: row.content });
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
            render: (v) => (v ? v.slice(0, 10) : "永不过期") },
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
function DataPanel() {
  const { message } = AntApp.useApp();
  const [overview, setOverview] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setOverview(null);
    adminApi.overview().then(setOverview).catch(() => setOverview({ error: true }));
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

  return (
    <div>
      {overview?.error ? (
        <PanelError onRetry={load} />
      ) : (
      <div className="metric-grid">
        <Metric label="数据库大小" value={overview ? `${overview.db_size_mb} MB` : "…"} />
        <Metric label="版本" value={overview?.version ?? "…"} />
      </div>
      )}
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
        <div className="row">对象存储自动备份（每日定时 + 异地留存）将在后续版本接入。</div>
      </section>
    </div>
  );
}
