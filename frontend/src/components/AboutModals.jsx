import { Modal } from "antd";
import { CHANGELOG } from "../legal/changelog";

// 设置页「关于」弹窗组：版本日志 + 开源声明（纯色无渐变、无 emoji，tokens 约束）
const GITHUB_REPO = "https://github.com/Yuntian-Liu/Autograde";
const GITHUB_HOME = "https://github.com/Yuntian-Liu";

const ACKNOWLEDGMENTS = [
  ["React", "前端框架"],
  ["Vite", "构建工具"],
  ["Ant Design", "UI 组件库"],
  ["React Router", "路由"],
  ["Recharts", "图表"],
  ["DiceBear", "头像生成（MIT）"],
  ["FastAPI", "后端框架"],
  ["SQLAlchemy", "数据库 ORM"],
  ["Pydantic", "数据校验"],
  ["PyJWT / bcrypt", "认证"],
];

export function ChangelogModal({ open, onClose }) {
  return (
    <Modal centered open={open} onCancel={onClose} footer={null} title="版本日志" width={480}>
      <div className="os-scroll">
        {CHANGELOG.map((release, i) => (
          <div className="os-block" key={release.version}>
            <div className="os-version-row">
              <span className={`os-version ${i === 0 ? "latest" : ""}`}>{release.version}</span>
              <span className="os-date">{release.date}</span>
            </div>
            <ul className="os-list">
              {release.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function OpenSourceModal({ open, onClose }) {
  return (
    <Modal centered open={open} onCancel={onClose} footer={null} title="开源声明" width={480}>
      <div className="os-scroll">
        {/* 项目仓库卡（accent 纯色，tokens 禁渐变） */}
        <a href={GITHUB_REPO} target="_blank" rel="noreferrer" className="os-repo">
          <div className="os-repo-main">
            <div className="os-repo-name">Autograde</div>
            <div className="os-repo-sub">英语作业批改工作台</div>
          </div>
          <span className="os-repo-link">GitHub →</span>
        </a>

        {/* 开发者卡 */}
        <div className="os-dev">
          <img className="os-dev-avatar" src={`${GITHUB_HOME}.png`} alt="开发者头像" />
          <div className="os-dev-info">
            <div className="os-dev-name">Yuntian-Liu</div>
            <div className="os-dev-sub">独立开发者 · 设计与实现</div>
          </div>
          <a href={GITHUB_HOME} target="_blank" rel="noreferrer" className="os-dev-link">
            主页 →
          </a>
        </div>

        {/* 许可证段 */}
        <div className="os-license">
          本项目以 <b>Apache License 2.0 + Commons Clause</b> 发布（source-available）：
          可自由查看、修改与自用部署，但不得将软件本身作为产品销售或提供收费托管服务。
        </div>

        {/* 开源致谢 */}
        <div className="os-ack-title">开源致谢</div>
        <div className="os-ack">
          {ACKNOWLEDGMENTS.map(([name, desc], i) => (
            <div className={`os-ack-row ${i === 0 ? "first" : ""}`} key={name}>
              <span className="os-ack-dot" />
              <span className="os-ack-name">{name}</span>
              <span className="os-ack-desc">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
