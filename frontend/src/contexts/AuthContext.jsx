import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { authApi, clearToken, getToken, UNAUTHORIZED_EVENT } from "../api";

// 登录态：mount 时用 token 拉 me 恢复；401 事件（api 层派发）清态
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    authApi
      .getMe()
      .then((u) => setUser(u))
      .catch(() => {
        /* 只在 401 清 token（api 层已派事件）；网络抖动等不误清 */
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handler = () => {
      clearToken();
      setUser(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, []);

  const login = useCallback((token, u) => {
    if (token) localStorage.setItem("autograde_token", token);
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  // 重新拉取当前用户（改资料后同步本地态）
  const refresh = useCallback(async () => {
    const u = await authApi.getMe();
    setUser(u);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
