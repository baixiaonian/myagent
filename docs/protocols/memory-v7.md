# 长期记忆 v7 协议与迁移

数据库 v7 与聊天 SSE v4 独立；本轮没有新聊天事件版本。HTTP/工具只返回 contracts/memory.ts 中的公开 DTO。

| 方法与路径 | 输入 / 行为 |
| --- | --- |
| GET `/api/v1/memories` | 设置、概览、正文版本、文件位置、最近任务/变更和实际整理用量 |
| POST `/api/v1/memories/sync` | 明确重读/恢复文件，返回概览和安全错误 |
| PUT `/api/v1/memories/settings` | `expectedRevision` + enabled/useMemories/generateMemories/idleMinutes/dailyRequests/taskRequests/requestTimeoutMs |
| GET `/api/v1/memories/entries` | query/project/kind/limit/cursor；最多 20 项、8000 字符 |
| GET `/api/v1/memories/entries/:id` | cursor/sourceId；正文、来源或提炼记录安全投影分页 |
| POST `/api/v1/memories/entries` | requestId、action=add/edit/forget；修改须 id/expectedRevision，新增须 title/text |
| POST `/api/v1/memories/undo` | id、expectedRevision（正文哈希）、requestId；只撤销最新有效变更 |
| POST `/api/v1/memories/jobs` | sessionId、requestId；手动整理旧历史 |
| POST `/api/v1/memories/jobs/:id/cancel` | 取消并拒绝迟到发布 |
| POST `/api/v1/memories/jobs/:id/retry` | 明确重试，保留已完成分块；不重放原业务工具 |
| GET/PUT `/api/v1/sessions/:id/memory` | useMemories / contributeMemories 独立开关，PUT 携带 expectedRevision |

条目包含稳定 id、标题、正文、种类、项目、revision、manual、status、来源、创建/更新时间。`needs_review` 可供页面查看，不能作为有效知识注入模型。来源包含程序生成 id、会话/原记录 ID、内容哈希、时间和真实状态。正文分页最后继续返回余下来源页；提炼产物通过 extractions 中的引用 ID 读取。游标绑定查询、会话和有效版本，内容变化后须重新查询。

任务状态：queued → running → completed；前台活动边界为 yielded；预算耗尽为 waiting_budget；失败/重启/取消/来源变化分别为 failed/interrupted/cancelled/stale。失败和中断同输入不自动再请求。阶段为 extract / consolidate / publish；每次模型请求单独计数，后台 usage 不混入聊天 Step。

## 文件格式与版本

```text
memories/
  MEMORY.md                  # 正文 + <!-- myagent:entry {JSON元数据} -->
  memory_summary.md          # 派生概览，不是第二份正文
  rollout_summaries/*.md     # 提炼产物与来源线索
```

正文格式标记为 `myagent:format 1`。页面与外部编辑共用一份文件；外部正文更改提高版本并标记人工维护。不能改条目 ID、来源、格式标记或通过概览文件更新正文。文件哈希冲突返回 409；非法文件保留原文件、公开错误并暂停读取，不清空有效索引。页面草稿不会被轮询覆盖。

v6→v7 新增 `memory_records(kind,id,data)`，JSON 类型在 state 契约中约束；kind 分别存设置、会话策略、条目索引、任务、变更、提交日志、来源排除标记、幂等、用量、元状态、访问排序和待重建队列。SQLite 索引不替代 Markdown 正文。升级默认关闭，不改历史、不启动模型；旧程序拒绝打开更新版本。

恢复时，先核对未完成文件提交，再读取正文构建索引。已发出但没有终态的请求标中断，用量未知；不因重启重发费用。删除会话的墓碑先于清理提交；旧来源任务不能重新发布。删除/关闭只撤销后续独立记忆注入，不能擦除已在聊天中引用的信息。
