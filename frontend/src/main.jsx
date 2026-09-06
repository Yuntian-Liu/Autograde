import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { AuthProvider } from "./contexts/AuthContext";
import { antdTheme } from "./theme";
// 字体自托管（fontsource）：不进网络、unicode-range 按需加载、基线一致
import "@fontsource/noto-serif-sc/500.css";
import "@fontsource/noto-serif-sc/600.css";
import "@fontsource/noto-serif-sc/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./tokens.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntApp>
        <ErrorBoundary>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>
);
