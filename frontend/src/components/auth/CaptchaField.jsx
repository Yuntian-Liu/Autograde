import { useEffect, useRef, useState } from "react";

// 自托管图形验证码：dev 模式（is_prod=false）后端 bypass，本组件渲染空并上报 null 占位
export default function CaptchaField({ onChange, refreshKey }) {
  const [captcha, setCaptcha] = useState(null); // {captcha_id, image}
  const [answer, setAnswer] = useState("");
  const [isProd, setIsProd] = useState(null);
  const genRef = useRef(0);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        setIsProd(Boolean(c.is_prod));
        if (!c.is_prod) onChange?.({ captchaId: null, answer: "dev-bypass" });
      })
      .catch(() => setIsProd(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isProd !== true) return;
    const gen = ++genRef.current;
    fetch("/api/captcha")
      .then((r) => r.json())
      .then((c) => {
        if (gen === genRef.current) {
          setCaptcha(c);
          setAnswer("");
          onChange?.({ captchaId: c.captcha_id, answer: "" });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProd, refreshKey]);

  if (isProd !== true) return null;

  return (
    <div className="captcha-row">
      {captcha && (
        <img className="captcha-img" src={captcha.image} alt="人机验证" title="点击换一张" onClick={() => {
          const gen = ++genRef.current;
          fetch("/api/captcha")
            .then((r) => r.json())
            .then((c) => {
              if (gen === genRef.current) {
                setCaptcha(c);
                setAnswer("");
                onChange?.({ captchaId: c.captcha_id, answer: "" });
              }
            })
            .catch(() => {});
        }} />
      )}
      <input
        className="captcha-input"
        value={answer}
        placeholder="输入图中字符"
        maxLength={8}
        onChange={(e) => {
          setAnswer(e.target.value);
          onChange?.({ captchaId: captcha?.captcha_id, answer: e.target.value });
        }}
      />
    </div>
  );
}
