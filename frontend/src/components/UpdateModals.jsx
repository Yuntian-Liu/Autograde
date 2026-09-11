import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal } from "antd";
import { AGREEMENT_VERSION, getLatestUpdate } from "../legal/changelog";
import { IconDoc, IconHistory } from "./icons";

// 登录后更新提醒（机制自 Stellaris 移植，UI 按 Autograde 令牌重做）
// - 版本更新：最新版本号与 localStorage 记录不符 → 弹「更新啦」（每版本一次）
// - 协议更新：AGREEMENT_VERSION 不符 → 弹「协议与政策更新」（每次协议修订一次）
// 两窗串联：版本窗关闭后才检查协议窗
const UPDATE_KEY = "autograde_last_seen_version";
const AGREEMENT_KEY = "autograde_last_seen_agreement";

export default function UpdateModals() {
  const navigate = useNavigate();
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showAgreement, setShowAgreement] = useState(false);

  // 启动检查：版本更新优先，关闭后串联检查协议更新
  useEffect(() => {
    const lastSeen = localStorage.getItem(UPDATE_KEY);
    const latest = getLatestUpdate();
    if (lastSeen !== latest.version) {
      setUpdateInfo(latest);
    } else {
      checkAgreement();
    }
  }, []);

  function checkAgreement() {
    if (localStorage.getItem(AGREEMENT_KEY) !== AGREEMENT_VERSION) {
      setShowAgreement(true);
    }
  }

  function closeUpdate() {
    localStorage.setItem(UPDATE_KEY, updateInfo.version);
    setUpdateInfo(null);
    checkAgreement();
  }

  function closeAgreement() {
    localStorage.setItem(AGREEMENT_KEY, AGREEMENT_VERSION);
    setShowAgreement(false);
  }

  function viewAgreement() {
    closeAgreement();
    navigate("/settings", { state: { openLegal: true } });
  }

  return (
    <>
      <Modal open={!!updateInfo} onCancel={closeUpdate} footer={null} width={440} centered>
        {updateInfo && (
          <div className="um-update">
            <span className="um-icon">
              <IconHistory />
            </span>
            <h2 className="um-title">Autograde 更新啦</h2>
            <div className="um-sub">
              {updateInfo.version} · {updateInfo.date}
            </div>
            {/* 内容区限高滚动（长日志不撑爆弹窗，标题与按钮常驻） */}
            <ul className="um-list">
              {updateInfo.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
            <button className="btn primary um-ok" onClick={closeUpdate}>
              知道了
            </button>
          </div>
        )}
      </Modal>

      <Modal open={showAgreement} onCancel={closeAgreement} footer={null} width={440} centered>
        <div className="um-agreement">
          <span className="um-icon">
            <IconDoc />
          </span>
          <h2 className="um-title">协议与政策更新</h2>
          <p className="um-text">
            《用户协议》与《隐私政策》已于 {AGREEMENT_VERSION.replace(/\.\d+$/, "")} 更新，
            继续使用本服务即表示你同意最新条款。
          </p>
          <div className="um-actions">
            <button className="btn" onClick={viewAgreement}>
              查看协议
            </button>
            <button className="btn primary" onClick={closeAgreement}>
              我已知晓
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
