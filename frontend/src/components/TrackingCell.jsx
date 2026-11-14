import { IconCheck } from "./icons";

export default function TrackingCell({ item, cell, saving = false, onToggle }) {
  const submitted = Boolean(cell?.submitted);
  const automatic = Boolean(item.is_main && cell?.source === "auto");
  const label = automatic ? "批改自动登记" : submitted ? "手动已交" : "待提交";
  return (
    <span title={automatic ? "批改自动登记，不能手动取消" : label}>
      <button
        type="button"
        className={`tracking-cell ${submitted ? "submitted" : ""}`}
        disabled={saving || automatic}
        aria-label={`${item.name}：${label}`}
        onClick={onToggle}
      >
        {saving ? "…" : submitted ? <IconCheck /> : "待提交"}
      </button>
    </span>
  );
}
