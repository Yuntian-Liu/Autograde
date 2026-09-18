// 保存状态灯（常驻）：绿=已同步 / 橙=有未保存修改 / 红=保存失败 / 保存中转圈文字
// 与防丢弹窗互为冗余：弹窗拦「离开」，灯报「当前」
export default function SaveStatus({ dirty, saving, failed }) {
  const state = saving ? "saving" : failed ? "failed" : dirty ? "dirty" : "synced";
  const map = {
    synced: { cls: "ok", text: "已同步" },
    dirty: { cls: "warn", text: "有未保存修改" },
    failed: { cls: "err", text: "保存失败" },
    saving: { cls: "warn", text: "保存中…" },
  };
  const s = map[state];
  return (
    <span className={`save-status ${s.cls}`} role="status">
      <i className="save-status-dot" />
      {s.text}
    </span>
  );
}
