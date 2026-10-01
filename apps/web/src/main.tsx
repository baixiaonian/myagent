/**
 * Web 启动入口：加载全局样式并将聊天工作台挂载到 HTML 根节点。
 * StrictMode 用于开发期发现生命周期问题；网络访问与业务交互留在 App 和 SDK。
 */

import { ChatClient } from "@myagent/sdk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { TracePageView } from "./features/observability/TracePage.js";
import "highlight.js/styles/github.css";
import "./styles.css";
import "./workspace.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");
// Trace 路由只装载观测页，不挂载聊天副作用；新标签打开保留原工作台的草稿和 SSE。
const traceMatch = /^\/traces\/([^/]+)\/?$/.exec(location.pathname);
// 非法百分号转义也交给正常的“记录不存在”视图，不让入口解码异常导致白屏。
let traceId = traceMatch?.[1] ?? "";
try {
  traceId = decodeURIComponent(traceId);
} catch {
  /* 使用原文身份查询。 */
}
const traceClient = new ChatClient();
createRoot(container).render(
  <StrictMode>
    {traceMatch ? (
      <TracePageView client={traceClient} traceId={traceId} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
