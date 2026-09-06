import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { authApi } from "../api";
import { useAuth } from "../contexts/AuthContext";
import AgreementModal from "../components/AgreementModal";
import Confetti from "../components/Confetti";
import CaptchaField from "../components/auth/CaptchaField";
import CodeInput from "../components/auth/CodeInput";
import { avatarUrl, randomSeed } from "../utils/avatar";

// 密码强度规则（与后端 validate_password_strength 对齐）
const SYMBOLS = "!@#$%^&*()-_=+[]{}|;:,.<>?/";
const PWD_RULES = [
  { key: "len", label: "至少 8 位", test: (p) => p.length >= 8 },
  { key: "letter", label: "含字母", test: (p) => /[A-Za-z]/.test(p) },
  { key: "digit", label: "含数字", test: (p) => /\d/.test(p) },
  { key: "symbol", label: "含符号", test: (p) => [...p].some((c) => SYMBOLS.includes(c)) },
];

const AVATAR_COUNT = 9;

export default function Login() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from || "/";

  const [step, setStep] = useState("email"); // email / code / avatar / profile / success
  const [tab, setTab] = useState("code"); // 登录方式 Tab：code=验证码 / password=密码（真受控切换，不提交）
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [avatarSeed, setAvatarSeed] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [needInvite, setNeedInvite] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [captchaRefresh, setCaptchaRefresh] = useState(0);
  const [seedBatch, setSeedBatch] = useState(0); // 「换一批」重新生成头像池
  const [agreed, setAgreed] = useState(false); // 协议勾选（发码前必须同意）
  const [legalOpen, setLegalOpen] = useState(false);
  const captchaRef = useRef(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [countdown]);

  const pwdOk = useMemo(() => PWD_RULES.every((r) => r.test(password)), [password]);

  // 输入框通吃邮箱与 UID：纯数字（1-18 位）视为 UID；UID 路径验证码步不回显邮箱（防枚举）
  const isUidIdentity = /^\d{1,18}$/.test(email.trim());

  // ── 第一步：邮箱或 UID（验证码 / 密码双通道）──
  async function sendCode() {
    setError("");
    if (!email.trim()) return setError("请输入邮箱地址或 UID");
    if (!agreed) return setError("请先阅读并同意用户协议和隐私政策");
    if (!captchaRef.current || !captchaRef.current.answer)
      return setError("请完成人机验证");
    setBusy(true);
    try {
      // 顺带探测注册是否需要邀请码（新用户注册步显示输入框）；UID 路径不探测
      if (!isUidIdentity) {
        authApi.checkEmail(email.trim()).then((r) => setNeedInvite(r.need_invite)).catch(() => {});
      }
      await authApi.sendCode(email.trim(), captchaRef.current);
      setCountdown(60);
      setStep("code");
    } catch (e) {
      setError(e.message);
      setCaptchaRefresh((k) => k + 1); // 票据一次性，失败换新题
    } finally {
      setBusy(false);
    }
  }

  async function loginPassword() {
    setError("");
    if (!email.trim() || !password) return setError("请输入邮箱/UID 和密码");
    if (!captchaRef.current || !captchaRef.current.answer)
      return setError("请完成人机验证");
    setBusy(true);
    try {
      const res = await authApi.loginPassword(email.trim(), password, captchaRef.current);
      login(res.token, res.user);
      navigate(from, { replace: true });
    } catch (e) {
      setError(e.message);
      setCaptchaRefresh((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  // ── 第二步：6 位验证码 ──
  async function submitCode() {
    setError("");
    if (code.length !== 6) return setError("请输入 6 位验证码");
    setBusy(true);
    try {
      const res = await authApi.loginCode(email.trim(), code);
      if (res.need_register) {
        // 进入注册流程前清空登录密码（两个密码字段语义不同，防串味）
        setPassword("");
        setPassword2("");
        setStep("avatar"); // 验证码留在 state，register 时二次提交
      } else {
        login(res.token, res.user);
        navigate(from, { replace: true });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (countdown > 0) return;
    setError("");
    if (!captchaRef.current || !captchaRef.current.answer)
      return setError("请完成人机验证");
    try {
      await authApi.sendCode(email.trim(), captchaRef.current);
      setCountdown(60);
    } catch (e) {
      setError(e.message);
      setCaptchaRefresh((k) => k + 1);
    }
  }

  // ── 第三步：选头像 ──
  function nextFromAvatar() {
    if (!avatarSeed) return setError("请选择一个头像");
    setStep("profile");
  }

  // ── 第四步：昵称 + 密码（+ 邀请码）──
  async function submitRegister() {
    setError("");
    if (!nickname.trim()) return setError("请输入昵称");
    if (!pwdOk) return setError("密码不满足强度要求");
    if (password !== password2) return setError("两次输入的密码不一致");
    if (needInvite && !inviteCode.trim()) return setError("请输入邀请码");
    setBusy(true);
    try {
      const res = await authApi.register({
        email: email.trim(),
        code,
        nickname: nickname.trim(),
        avatar_seed: avatarSeed,
        password,
        invite_code: inviteCode.trim() || null,
      });
      login(res.token, res.user);
      setStep("success");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const seeds = useMemo(
    () => Array.from({ length: AVATAR_COUNT }, () => randomSeed()),
    [seedBatch]
  );

  return (
    <div className="login-wrap page-enter">
      <div className="login-card">
        <div className="login-brand">
          <h1>
            Auto<em>grade</em>
          </h1>
          <p>英语作业批改工作台</p>
        </div>

        {error && <div className="login-error">{error}</div>}

        {step === "email" && (
          <div className="login-step">
            <div className="login-mode">
              <button
                type="button"
                className={tab === "code" ? "on" : ""}
                onClick={() => {
                  setTab("code");
                  setError("");
                }}
              >
                验证码登录
              </button>
              <button
                type="button"
                className={tab === "password" ? "on" : ""}
                onClick={() => {
                  setTab("password");
                  setError("");
                }}
              >
                密码登录
              </button>
            </div>
            <input
              className="login-input"
              placeholder="邮箱地址或 UID"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (tab === "code" ? sendCode() : loginPassword())}
            />
            {tab === "password" && (
              <input
                className="login-input"
                type="password"
                placeholder="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loginPassword()}
              />
            )}
            <CaptchaField
              key={captchaRefresh}
              refreshKey={captchaRefresh}
              onChange={(c) => (captchaRef.current = c)}
            />
            {tab === "code" && (
              <label className="agree-row">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                <span>
                  我已阅读并同意
                  <a onClick={() => setLegalOpen(true)}>用户协议</a>和
                  <a onClick={() => setLegalOpen(true)}>隐私政策</a>
                </span>
              </label>
            )}
            <button
              className="login-btn"
              onClick={tab === "code" ? sendCode : loginPassword}
              disabled={busy}
            >
              {busy ? "请稍候…" : tab === "code" ? "发送验证码" : "登录"}
            </button>
            {tab === "code" && <p className="login-hint">新邮箱验证通过后将引导注册</p>}
          </div>
        )}

        {step === "code" && (
          <div className="login-step">
            <h2>输入验证码</h2>
            <p className="login-hint">
              {isUidIdentity ? "验证码已发送至该账号绑定的邮箱" : `已发送至 ${email}`}
            </p>
            <CodeInput value={code} onChange={setCode} />
            <button className="login-btn" onClick={submitCode} disabled={busy || code.length !== 6}>
              {busy ? "验证中…" : "验证并登录"}
            </button>
            <div className="login-resend">
              {/* 倒计时结束后才展人机验证（重发必须现场完成新票据，一次性）；倒计时期间只显示等待文案 */}
              {countdown <= 0 && (
                <CaptchaField
                  key={`code-${captchaRefresh}`}
                  refreshKey={captchaRefresh}
                  onChange={(c) => (captchaRef.current = c)}
                />
              )}
              <button
                type="button"
                onClick={resend}
                disabled={countdown > 0}
              >
                {countdown > 0 ? `${countdown}s 后可重发` : "完成验证并重发"}
              </button>
            </div>
          </div>
        )}

        {step === "avatar" && (
          <div className="login-step">
            <h2>选一个头像</h2>
            <div className="avatar-grid">
              {seeds.map((seed) => (
                <button
                  type="button"
                  key={seed}
                  className={`avatar-cell ${seed === avatarSeed ? "on" : ""}`}
                  onClick={() => setAvatarSeed(seed)}
                >
                  <img src={avatarUrl(seed)} alt="" />
                </button>
              ))}
            </div>
            <div className="login-btn-row">
              <button
                type="button"
                className="login-btn ghost"
                onClick={() => {
                  setAvatarSeed("");
                  setSeedBatch((k) => k + 1);
                }}
              >
                换一批
              </button>
              <button type="button" className="login-btn" onClick={nextFromAvatar}>
                下一步
              </button>
            </div>
          </div>
        )}

        {step === "profile" && (
          <div className="login-step">
            <h2>完善资料</h2>
            <input
              className="login-input"
              placeholder="昵称（家长看到的名字建议用中文）"
              value={nickname}
              autoFocus
              onChange={(e) => setNickname(e.target.value)}
            />
            <input
              className="login-input"
              type="password"
              placeholder="设置密码（至少 8 位，含字母/数字/符号）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input
              className="login-input"
              type="password"
              placeholder="确认密码"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
            />
            <div className="pwd-rules">
              {PWD_RULES.map((r) => (
                <span key={r.key} className={r.test(password) ? "pass" : ""}>
                  {r.label}
                </span>
              ))}
            </div>
            {needInvite && (
              <input
                className="login-input"
                placeholder="邀请码"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            )}
            <button className="login-btn" onClick={submitRegister} disabled={busy}>
              {busy ? "创建中…" : "创建账号"}
            </button>
          </div>
        )}

        {step === "success" && (
          <div className="login-step login-success">
            <Confetti />
            <img className="login-avatar" src={avatarUrl(avatarSeed)} alt="" />
            <h2>欢迎加入，{nickname}</h2>
            <p className="login-uid">UID {user?.uid}</p>
            <button className="login-btn" onClick={() => navigate(from, { replace: true })}>
              开始使用
            </button>
          </div>
        )}
      </div>

      <AgreementModal open={legalOpen} onClose={() => setLegalOpen(false)} />
    </div>
  );
}
