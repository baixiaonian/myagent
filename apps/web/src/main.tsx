/**
 * Web 启动入口：加载全局样式并将聊天工作台挂载到 HTML 根节点。
 * StrictMode 用于开发期发现生命周期问题；网络访问与业务交互留在 App 和 SDK。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "highlight.js/styles/github.css";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
