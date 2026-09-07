import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { App as AntApp, Avatar, Input, Modal } from "antd";
import { apiGet, apiPut, getToken } from "../api";
import AppHeader from "../components/AppHeader";
import AgreementModal from "../components/AgreementModal";
import { ChangelogModal, OpenSourceModal } from "../components/AboutModals";
import {
  IconAvatar,
  IconChart,
  IconCode,
  IconDoc,
  IconDownload,
  IconHistory,
  IconInfo,
  IconLock,
  IconLogout,
  IconUser,
} from "../components/icons";
import { useAuth } from "../contexts/AuthContext";
import { avatarUrl, randomSeed } from "../utils/avatar";
import { clientLog } from "../utils/clientLog";

// 设置页（iOS 设置风格）：资料卡 + 数据横幅 + 分组行项；协议/改密/换头像/诊断导出/登出
function RowItem({ icon, tint, label, value, onClick, arrow = true, danger = false }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`set-row ${onClick ? "click" : ""} ${danger ? "danger" : ""}`} onClick={onClick}>
      <span className="set-ico" style={{ color: tint }}>
        {icon}
      </span>
      <span className="set-label">{label}</span>
      {value && <span className="set-value">{value}</span>}
      {arrow && onClick && <span className="set-arrow">→</span>}
    </Tag>
  );
}

function SectionCard({ title, children }) {
  return (
    <section className="set-card">
      {title && <div className="set-card-title">{title}</div>}
      {children}
    </section>
  );
}

export default function Settings() {
  const { user, logout, refresh } = useAuth();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();

  const [stats, setStats] = useState(null); // {classes, students}
  const [nickOpen, setNickOpen] = useState(false);
  const [nickname, setNickname] = useState("");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarSeeds, setAvatarSeeds] = useState([]);
  const [pickedSeed, setPickedSeed] = useState("");
  const [pwdOpen, setPwdOpen] = useState(false);
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [legalOpen, setLegalOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [openSourceOpen, setOpenSourceOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet("/classes")
      .then((cs) =>
        setStats({
          classes: cs.length,
          students: cs.reduce((sum, c) => sum + (c.student_count || 0), 0),
        })
      )
      .catch(() => {});
  }, []);

  const seeds = useMemo(() => avatarSeeds, [avatarSeeds]);

  function openNickname() {
    setNickname(user?.nickname || "");
    setNickOpen(true);
  }

  function openAvatar() {
    setAvatarSeeds(Array.from({ length: 9 }, () => randomSeed()));
    setPickedSeed("");
    setAvatarOpen(true);
  }

  async function saveNickname() {
    if (!nickname.trim()) return message.error("昵称不能为空");
    setSaving(true);
    try {
      await apiPut("/auth/profile", { nickname: nickname.trim() });
      await refresh();
      message.success("昵称已更新");
      setNickOpen(false);
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveAvatar() {
    if (!pickedSeed) return message.error("请选择一个头像");
    setSaving(true);
    try {
      await apiPut("/auth/profile", { avatar_seed: pickedSeed });
      await refresh();
      message.success("头像已更新");
      setAvatarOpen(false);
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function savePassword() {
    if (newPwd.length < 8) return message.error("新密码至少 8 位");
    if (newPwd !== newPwd2) return message.error("两次输入的新密码不一致");
    setSaving(true);
    try {
      await apiPut("/auth/change-password", {
        old_password: oldPwd,
        new_password: newPwd,
      });
      message.success("密码已修改");
      setPwdOpen(false);
      setOldPwd("");
      setNewPwd("");
      setNewPwd2("");
    } catch (e) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }

  // 导出诊断日志：后端整包 + 前端事件/环境注入 → JSON 下载（生产 Debug 用）
  async function exportDiagnostics() {
    try {
      const res = await fetch("/api/diagnostics/export", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error(`导出失败 (${res.status})`);
      const data = await res.json();
      data.client_events = clientLog.dump();
      data.client_env = {
        userAgent: navigator.userAgent,
        language: navigator.language,
        screen: `${window.screen.width}x${window.screen.height}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        localTime: new Date().toString(),
        url: window.location.href,
        uid: user?.uid,
        hasToken: Boolean(getToken()),
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `autograde-diagnostics-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      message.success("诊断日志已导出");
    } catch (e) {
      message.error(e.message);
    }
  }

  function doLogout() {
    logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="page-enter">
      <AppHeader crumbs={[{ label: "工作台", to: "/" }, { label: "设置" }]} />
      <div className="wrap settings-wrap">
        <Link className="back" to="/">
          ← 工作台
        </Link>
        <h1 style={{ marginTop: "var(--s3)" }}>设置</h1>

        {/* 资料卡 */}
        <section className="set-profile">
          <Avatar size={72} src={avatarUrl(user?.avatar_seed)} />
          <div className="set-profile-info">
            <div className="set-name">
              {user?.nickname}
              {user?.is_admin && <span className="dev-badge">开发者</span>}
            </div>
            <div className="set-meta">
              {user?.email} · UID {user?.uid}
            </div>
          </div>
        </section>

        {/* 数据横幅（accent 色块，无渐变） */}
        {stats && (
          <section className="set-banner">
            <div>
              <div className="n">{stats.classes}</div>
              <div className="l">我的班级</div>
            </div>
            <div>
              <div className="n">{stats.students}</div>
              <div className="l">学生总数</div>
            </div>
            <div>
              <div className="n">{user?.is_admin ? "管理员" : "教师"}</div>
              <div className="l">账号角色</div>
            </div>
          </section>
        )}

        <SectionCard title="个人资料">
          <RowItem icon={<IconUser />} tint="var(--accent)" label="昵称" value={user?.nickname} onClick={openNickname} />
          <RowItem icon={<IconAvatar />} tint="var(--success)" label="头像" value="点击更换" onClick={openAvatar} />
        </SectionCard>

        <SectionCard title="账号安全">
          <RowItem icon={<IconLock />} tint="var(--warning)" label="修改密码" onClick={() => setPwdOpen(true)} />
        </SectionCard>

        <SectionCard title="支持">
          <RowItem
            icon={<IconDownload />}
            tint="var(--ink-2)"
            label="导出诊断日志"
            value="排查问题用"
            onClick={exportDiagnostics}
          />
        </SectionCard>

        <SectionCard title="关于">
          <RowItem icon={<IconDoc />} tint="var(--danger)" label="用户协议与隐私政策" onClick={() => setLegalOpen(true)} />
          <RowItem icon={<IconHistory />} tint="var(--accent)" label="版本日志" value="V0.4.0" onClick={() => setChangelogOpen(true)} />
          <RowItem icon={<IconCode />} tint="var(--success)" label="开源声明" onClick={() => setOpenSourceOpen(true)} />
          <RowItem icon={<IconInfo />} tint="var(--ink-2)" label="版本" value="V0.4.0" arrow={false} onClick={null} />
        </SectionCard>

        <SectionCard>
          <RowItem icon={<IconLogout />} tint="var(--danger)" label="退出登录" onClick={doLogout} arrow={false} danger />
        </SectionCard>
      </div>

      <Modal
        centered
        open={nickOpen}
        onCancel={() => setNickOpen(false)}
        onOk={saveNickname}
        confirmLoading={saving}
        title="修改昵称"
        okText="保存"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <Input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={24}
          placeholder="新的昵称"
          onPressEnter={saveNickname}
        />
      </Modal>

      <Modal
        centered
        open={avatarOpen}
        onCancel={() => setAvatarOpen(false)}
        onOk={saveAvatar}
        confirmLoading={saving}
        title="更换头像"
        okText="保存"
        cancelText="取消"
        width={420}
        destroyOnHidden
      >
        <div className="avatar-grid">
          {seeds.map((seed) => (
            <button
              type="button"
              key={seed}
              className={`avatar-cell ${seed === pickedSeed ? "on" : ""}`}
              onClick={() => setPickedSeed(seed)}
            >
              <img src={avatarUrl(seed)} alt="" />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn"
          style={{ width: "100%" }}
          onClick={() => setAvatarSeeds(Array.from({ length: 9 }, () => randomSeed()))}
        >
          换一批
        </button>
      </Modal>

      <Modal
        centered
        open={pwdOpen}
        onCancel={() => setPwdOpen(false)}
        onOk={savePassword}
        confirmLoading={saving}
        title="修改密码"
        okText="保存"
        cancelText="取消"
        width={400}
        destroyOnHidden
      >
        <div className="form-grid">
          <span className="flab">旧密码</span>
          <Input.Password value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} />
          <span className="flab">新密码</span>
          <Input.Password
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            placeholder="至少 8 位，含字母/数字/符号"
          />
          <span className="flab">确认新密码</span>
          <Input.Password value={newPwd2} onChange={(e) => setNewPwd2(e.target.value)} />
        </div>
        <p className="login-hint">忘记密码？退出后在登录页用邮箱验证码重置。</p>
      </Modal>

      <AgreementModal open={legalOpen} onClose={() => setLegalOpen(false)} />
      <ChangelogModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <OpenSourceModal open={openSourceOpen} onClose={() => setOpenSourceOpen(false)} />
    </div>
  );
}
