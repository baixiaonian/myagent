/** 命令策略内核：只组合可信分析与显式规则；解析 Shell、读取配置和操作系统检查由端口实现。 */
import type {
  CommandAnalysis,
  CommandDecision,
  CommandRule,
  CommandRuleMatch,
} from "@myagent/contracts";

export interface CommandAnalyzerPort {
  analyze(command: string, cwd: string): Promise<CommandAnalysis>;
}
const priority: Record<CommandDecision, number> = {
  allow: 0,
  prompt: 1,
  deny: 2,
};
/** 每个静态命令分别求值；任何一段拒绝/询问都不能被前一段 allow 掩盖。 */
export function evaluateCommands(
  analysis: CommandAnalysis,
  sources: { scope: "user" | "project"; rules: CommandRule[] }[],
): {
  decision: CommandDecision;
  reasons: string[];
  matches: CommandRuleMatch[];
} {
  let decision: CommandDecision = analysis.opaque ? "prompt" : "allow";
  const reasons = [...analysis.reasons];
  const matches: CommandRuleMatch[] = [];
  for (const [commandIndex, command] of analysis.commands.entries()) {
    const matched = sources.flatMap(({ scope, rules }) =>
      rules
        .filter((rule) =>
          rule.pattern.every((arg, i) => command.argv[i] === arg),
        )
        .map((rule) => ({ ...rule, scope, commandIndex })),
    );
    matches.push(...matched);
    const current: CommandDecision = matched.length
      ? matched.reduce<CommandDecision>(
          (value, rule) =>
            priority[rule.decision] > priority[value] ? rule.decision : value,
          "allow",
        )
      : command.safe
        ? "allow"
        : "prompt";
    if (priority[current] > priority[decision]) decision = current;
    reasons.push(
      matched.length
        ? `${command.argv[0]}：${matched.map((rule) => `${rule.scope}/${rule.id}=${rule.decision}`).join("，")}`
        : `${command.argv[0]}：${command.reason}`,
    );
  }
  if (!analysis.commands.length) {
    if (decision !== "deny") decision = "prompt";
    reasons.push("没有可可靠判断的静态命令。");
  }
  return { decision, reasons, matches };
}
