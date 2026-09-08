import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");

createRoot(container).render(
  <StrictMode>
    <main>
      <p className="eyebrow">MYAGENT / ENGINEERING SCAFFOLD</p>
      <h1>工程骨架已就绪</h1>
      <p>
        当前仅初始化项目结构、开发工具与文档。对话、模型调用、工具执行和任务运行尚未实现。
      </p>
      <section aria-labelledby="next-step">
        <h2 id="next-step">从项目文档开始迭代</h2>
        <p>
          新上下文先阅读根目录 AGENTS.md、docs/README.md 和 docs/STATUS.md。
        </p>
        <p>后续功能遵循模块边界，并同步更新状态、决策与迭代历史。</p>
      </section>
    </main>
  </StrictMode>,
);
