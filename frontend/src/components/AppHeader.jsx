import { Link } from "react-router-dom";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`;
}

export default function AppHeader({ compact = false, children, showDate = false }) {
  return (
    <header className={compact ? "app-header compact" : "app-header"}>
      <Link className="wordmark" to="/">
        Auto<em>grade</em>
      </Link>
      {children}
      {showDate && <span className="header-date">{today()}</span>}
    </header>
  );
}
