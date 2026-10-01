/** 设置导航协议：App 拥有页面选择，Modal 只呈现导航；切换不创建会话或写入任何配置。 */
import {
  Blocks,
  Brain,
  FileText,
  Plug,
  Settings2,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { createContext } from "react";

export const settingsPages = [
  {
    title: "模型设置",
    icon: Settings2,
    description: "连接模型，调整上下文容量与输出设置。",
  },
  {
    title: "技能",
    icon: FileText,
    description: "为 Agent 添加专业方法、工作流程和参考资料。",
  },
  {
    title: "MCP 服务",
    icon: Plug,
    description: "连接外部工具与数据，让 Agent 在任务中按需使用。",
  },
  { title: "插件", icon: Blocks, description: "管理打包的技能、工具与 Hook。" },
  {
    title: "Hook",
    icon: Workflow,
    description: "管理任务生命周期中的自动脚本。",
  },
  {
    title: "长期记忆",
    icon: Brain,
    description: "查看和维护跨对话保留的知识。",
  },
  {
    title: "命令权限",
    icon: ShieldCheck,
    description: "决定哪些命令允许执行、需要确认或禁止运行。",
  },
] as const;
export const SettingsNavigation = createContext<
  ((title: string) => void) | null
>(null);
