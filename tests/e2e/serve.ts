/**
 * 端到端测试服务入口：创建临时数据目录、本地协议替身和生产 Web 托管服务。
 * 收到退出信号时先关闭生成与连接，再删除自己创建的数据，绝不复用用户目录。
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../apps/server/src/bootstrap/index.js";
import { mockProvider } from "../chat/provider.js";
import { mcpFixture } from "../execution/mcp-fixture.js";

// 专用端口由 Playwright 配置约定，临时目录由本进程创建；冲突时失败，不接管其他服务。
const dataDir = mkdtempSync(join(tmpdir(), "myagent-e2e-"));
const workRoot = realpathSync(mkdtempSync(join(tmpdir(), "myagent-e2e-work-")));
const workspacePath = join(workRoot, "work");
const outsidePath = join(workRoot, "outside", "note.txt");
mkdirSync(workspacePath);
mkdirSync(join(workspacePath, "output"));
writeFileSync(
  join(workspacePath, "output/article.md"),
  "# 工作区文档\n\n这段文字可以选中编辑。\n\n## 核心结论\n\n保留原有内容，记录每次修改。\n\n| 项目 | 状态 |\n| --- | --- |\n| 编辑器 | 可用 |\n",
);
writeFileSync(
  join(workspacePath, "output/report.html"),
  '<!doctype html><html><head><title>测试报告</title><style>body{font:16px/1.8 system-ui;padding:36px;color:#304b42;background:#f6f8f3}h1{font-size:30px}article{background:white;padding:30px;border-radius:12px}</style></head><body><img src="http://127.0.0.1:14317/document-network-probe"><iframe src="http://127.0.0.1:14317/document-network-probe"></iframe><article><h1>文档工作区</h1><p>选择这段内容进行编辑 &amp; 提问。</p></article><script>document.body.setAttribute("data-original-script","executed");fetch("/api/v1/settings").catch(()=>{});window.parent.postMessage("UNSAFE_SCRIPT","*")</script></body></html>',
);
writeFileSync(
  join(workspacePath, "output/advanced.md"),
  "---\ntitle: 保留元数据\n---\n\n# 扩展文档\n<!-- 不可丢失的注释 -->\n",
);
// 交互报表通过原文脚本生成数据；各越权入口只请求本地测试探针，不能接触真实服务。
writeFileSync(
  join(workspacePath, "output/dynamic.html"),
  `<!doctype html><html><head><meta charset="utf-8"><style>body{font:16px system-ui;margin:20px}button{display:block;margin:10px 0}table{width:100%}</style></head><body>
<h1>动态报表</h1><b id="total">–</b><select aria-label="月份" id="month"></select><table><tbody id="rows"></tbody></table>
<p id="parent-state"></p><p id="network-state"></p>
<button onclick="document.querySelector('#clicked').textContent='已交互'">内联事件</button><span id="clicked"></span>
<button id="probe">检查网络</button><button id="forge">伪造编辑消息</button>
<button id="navigate">跳转接口</button><button id="popup">打开弹窗</button>
<script>
const data=[['一月',100],['一月',200],['二月',400]], month=document.querySelector('#month');
month.innerHTML='<option value="">全部</option><option>一月</option><option>二月</option>';
function render(){const rows=data.filter(r=>!month.value||r[0]===month.value);document.querySelector('#total').textContent=rows.reduce((n,r)=>n+r[1],0);document.querySelector('#rows').innerHTML=rows.map(r=>'<tr><td>'+r[0]+'</td><td>'+r[1]+'</td></tr>').join('')}
month.onchange=render;render();
try{top.document.body.dataset.previewEscape='true';document.querySelector('#parent-state').textContent='越界'}catch{document.querySelector('#parent-state').textContent='宿主隔离'}
document.querySelector('#probe').onclick=async()=>{
  const url='http://127.0.0.1:14317/document-network-probe';
  const img=new Image();img.src=url+'?image';document.body.append(img);
  const frame=document.createElement('iframe');frame.src=url+'?frame';document.body.append(frame);
  const form=document.createElement('form');form.action=url+'?form';form.method='post';document.body.append(form);form.submit();
  try{await fetch(url+'?fetch');document.querySelector('#network-state').textContent='越界'}catch{document.querySelector('#network-state').textContent='网络阻止'}
};
document.querySelector('#forge').onclick=()=>{top.postMessage({kind:'document-selection',token:'fake',text:'伪造选区',start:0,end:4,from:0,to:4},'*')};
document.querySelector('#navigate').onclick=()=>{location.href='http://127.0.0.1:14317/document-network-probe?navigation'};
document.querySelector('#popup').onclick=()=>{window.open('http://127.0.0.1:14317/document-network-probe?popup')};
</script></body></html>`,
);
mkdirSync(join(workRoot, "outside"));
writeFileSync(outsidePath, "外部中文说明");
const skillRoot = join(workRoot, "skills");
mkdirSync(join(skillRoot, "sales-report/references"), { recursive: true });
writeFileSync(
  join(skillRoot, "sales-report/SKILL.md"),
  "---\nname: sales-report\ndescription: 整理销售报表\n---\n报告必须使用 E2E_SKILL_RULE。参考 references/format.md。",
);
writeFileSync(
  join(skillRoot, "sales-report/references/format.md"),
  "按月份汇总，显示总额。",
);
const hookPackage = join(workRoot, "hook-package");
mkdirSync(hookPackage);
writeFileSync(
  join(hookPackage, "main.mjs"),
  '/** E2E Hook。 */\nconsole.log(JSON.stringify({decision:"continue",additionalContext:"E2E_HOOK_CONTEXT"}));',
);
const fixture = await mcpFixture();
mkdirSync(".cache", { recursive: true });
writeFileSync(
  ".cache/execution-e2e.json",
  JSON.stringify({
    workspacePath,
    outsidePath,
    mcpUrl: fixture.url,
    hookPackage,
  }),
);
const provider = await mockProvider(14318, (question, results, definitions) => {
  if (question === "展示项目文档")
    return {
      calls: [],
      text: "交付内容：`output/article.md`，另见 [HTML 报告](output/report.html)。",
    };
  if (question === "团队产品验收")
    return results.length
      ? { calls: [], text: "团队产品验收已完成。" }
      : {
          text: "分配核验工作，我负责整合。",
          calls: [
            {
              id: "team-create",
              name: "spawn_agent",
              arguments: JSON.stringify({
                name: "核验成员",
                instructions: "读取并核验测试结果",
                task: "团队成员产品任务",
              }),
            },
          ],
        };
  if (question === "团队成员产品任务")
    return results.length
      ? { calls: [], text: "成员完成真实命令核验。" }
      : {
          text: "准备核验。",
          calls: [
            {
              id: "team-exec",
              name: "exec_command",
              arguments: JSON.stringify({
                command: "node -e \"console.log('TEAM_READY')\"",
              }),
            },
          ],
        };
  if (
    question.startsWith("[{") &&
    question.includes('"index"') &&
    question.includes('"createdAt"')
  )
    return {
      calls: [],
      text: JSON.stringify({
        memories: [
          {
            title: "星舟知识",
            text: "日志目录是星舟仓库。",
            kind: "project",
            projectSpecific: true,
            sourceIndexes: [0],
          },
        ],
      }),
    };
  if (question.startsWith('{"candidates":')) {
    const data = JSON.parse(question);
    return {
      calls: [],
      text: JSON.stringify({
        actions: data.candidates.map(
          (c: { candidateIndex: number; title: string; text: string }) => ({
            ...c,
            action: "add",
          }),
        ),
      }),
    };
  }
  if (question.includes('"previousSummary"') && question.includes('"records"'))
    return {
      calls: [],
      text: "历史已完成日志检查，关键事实仍保存在原文；继续处理当前问题。",
    };
  if (question === "上下文长任务")
    return { calls: [], text: "已经确认的历史事实。".repeat(3000) };
  if (question === "继续上下文任务")
    return { calls: [], text: "摘要后继续成功。" };
  if (question.includes("命令权限验收"))
    return {
      calls: results.length
        ? []
        : [
            {
              id: "command",
              name: "exec_command",
              arguments: JSON.stringify({ command: "rm command-fixture.txt" }),
            },
          ],
      text: results.length ? "命令请求已处理。" : "准备处理测试命令。",
    };
  if (question.includes("查看外部说明"))
    return {
      calls: results.length
        ? []
        : [
            {
              id: "outside",
              name: "read_file",
              arguments: JSON.stringify({ path: outsidePath }),
            },
          ],
      text: results.length ? "外部说明请求已处理。" : "我先读取说明。",
    };
  if (question.includes("转交回声服务")) {
    const tools = definitions as {
      name?: string;
      function?: { name: string };
    }[];
    const echo = tools
      .map((tool) => tool.name ?? tool.function?.name)
      .find((name) => name?.startsWith("mcp_"));
    // 协议替身只在目录缺少回声定义时搜索；搜索结果有 evicted 字段，业务结果则结束本轮。
    // 因此浏览器可验证追问/重新运行复用定义，不能用固定两次调用掩盖重复搜索。
    const complete = results.some(
      (result) => !result.content.includes('"evicted":'),
    );
    return {
      calls: complete
        ? []
        : !echo
          ? [
              {
                id: "search",
                name: "search_tools",
                arguments: JSON.stringify({ query: "echo" }),
              },
            ]
          : echo
            ? [
                {
                  id: "echo",
                  name: echo,
                  arguments: JSON.stringify({
                    text: question.includes("让服务超时") ? "hang" : "large",
                  }),
                },
              ]
            : [],
      text: complete ? "回声服务已返回结果。" : "我先找到可用的服务。",
    };
  }
  return null;
});
const { server } = await buildServer({
  dataDir,
  workspaceRoot: join(workRoot, "defaults"),
  skillRoot,
  directoryPicker: async () => ({ status: "selected", path: workspacePath }),
  logger: false,
  agentLimits: { toolTimeoutMs: 1000 },
});
await server.listen({ host: "127.0.0.1", port: 14317 });
console.info(
  "本地测试实例 http://127.0.0.1:14317；模拟模型 http://127.0.0.1:14318/v1",
);
let closing = false;
// 先停止生成并关闭数据库，再关假模型和删除目录，避免异步写入落到已删除路径。
const stop = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await provider.close();
  await fixture.close();
  rmSync(workRoot, { recursive: true, force: true });
  rmSync(".cache/execution-e2e.json", { force: true });
  rmSync(dataDir, { recursive: true, force: true });
};
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
