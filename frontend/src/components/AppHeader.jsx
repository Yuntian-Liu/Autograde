import { Link, useNavigate } from "react-router-dom";
import { Avatar, Dropdown } from "antd";
import { useAuth } from "../contexts/AuthContext";
import { avatarUrl } from "../utils/avatar";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`;
}

// 顶栏：wordmark + 可点击面包屑 + 右侧扩展位（截止日期等）+ 日期 + 用户菜单
// crumbs: [{ label, to? }]，无 to 的末级为当前页（不可点）
export default function AppHeader({ compact = false, crumbs = [], children, showDate = false }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // user 可能为 null（登录态初始化中的骨架屏也渲染本组件），必须可选链
  const items = [
    ...(user?.is_admin ? [{ key: "admin", label: "管理后台" }] : []),
    { key: "settings", label: "设置" },
    { type: "divider" },
    { key: "logout", label: "退出登录" },
  ];

  function onMenu({ key }) {
    if (key === "logout") {
      logout();
      navigate("/login", { replace: true });
    } else if (key === "settings") {
      navigate("/settings");
    } else if (key === "admin") {
      navigate("/admin");
    }
  }

  return (
    <header className={compact ? "app-header compact" : "app-header"}>
      <Link className="wordmark" to="/">
        Auto<em>grade</em>
      </Link>
      {crumbs.length > 0 && (
        <nav className="crumbs">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="sep">/</span>}
              {c.to ? (
                <Link className="crumb-link" to={c.to}>
                  {c.label}
                </Link>
              ) : (
                <span className="crumb-current">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      {children}
      {showDate && <span className="header-date">{today()}</span>}
      {user && (
        <Dropdown
          menu={{ items, onClick: onMenu }}
          placement="bottomRight"
          trigger={["click"]}
        >
          <button className="user-chip" type="button">
            <Avatar size={26} src={avatarUrl(user.avatar_seed)} />
            <span className="user-name">{user.nickname}</span>
            {user.is_admin && <span className="dev-badge">开发者</span>}
          </button>
        </Dropdown>
      )}
    </header>
  );
}
