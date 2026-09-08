# 2026-09-08：真实模型与 Docker 补充验收

## 目标与授权

用户已在设置页面配置模型，要求完成全部测试。本轮使用已保存连接进行真实请求，补齐原先未验收的 Docker 构建与恢复；不读取 / 复制真实凭证文件，不覆盖用户设置，不对外发布。

## 真实模型结果

连接：用户配置的 DeepSeek `deepseek-v4-flash`，配置 revision=2。实际连接测试通过且不写聊天历史。专门创建的「真实模型验收 · 多轮与停止」会话保留，sessionId 为 `8af3eea6-3787-4ae2-8bb7-6f659f6c8cb7`，用户原有会话保留。

| 用例 | 实际结果 |
| --- | --- |
| 首轮输入随机暗号，要求记住 | succeeded，730ms；文字增量先落盘，重复提交返回同一 Run |
| 第二轮要求回忆上一轮暗号 | succeeded，1457ms；准确返回随机暗号，证明上下文真正带入 |
| 重新生成第二轮 | succeeded，2002ms；原答标记 superseded，用户问题仍只有两条 |
| 长输出收到首批文字后停止 | cancelled，保留 30 字符；此用例等待首批文字较久，总耗时 80719ms |
| 停止后再次读取快照 | 无活动 Run，部分回答不再增长 |
| Web 输入框发真实 Markdown 问题 | 正常完成，渲染为两个列表项 |
| 浏览器刷新 | 四轮问题、四个当前回答、停止标记完整恢复 |
| 配置边界 | 测试前后 revision=2，未更换 / 清除密钥，脱敏 API 无 apiKey / credentialRef |

短回答在 250ms 合并窗口内完成时可能只有一个持久化 delta，这不是逐 token 数量；长回答停止用例证实真实流仍在运行时可以取消。供应商远端是否立即终止所有计算和计费未由本机状态推断。

原始机器可读摘要保存在 `.cache/acceptance/live-model.json` 和 `.cache/acceptance/live-web.json`；不含密钥或完整聊天。历史中的上一轮“未验收”记录保留为当时事实。

## 发现和修复

1. Docker 构建初次 APT 下载长时间无进展；为构建步骤加入 IPv4、30 秒超时和 3 次重试，重试后包索引下载约 11 秒完成。未修改宿主机网络，也未关闭 TLS 验证。
2. 进程锁默认位于数据目录旁。对容器普通用户而言 `/data` 可写，但 `/data.lock` 的父目录不可写。新增回归先复现 EACCES，再将锁改到数据目录内 `server.lock`；保持旧版本目录旁锁的活动检查。升级前先停旧实例。
3. 新增 `pnpm test:live` 和 `pnpm test:docker`，真实模型测试不加入默认 verify / CI，避免隐式费用。Docker 用唯一 project / 随机 loopback 端口 / 独立测试卷，故障注入不操作真实用户数据。

## 自动化与 Docker

32 项 Vitest（原有 31 项 + 只读父目录回归）通过；5 组 Chromium E2E 通过。完整 verify 在交付前再次执行。

Docker Engine 29.4.0 / Compose 5.1.2，Node 24.20.0，linux/arm64。镜像 `myagent:acceptance-v1` 构建成功，image ID 为 `sha256:ece24906e11d802f810f52ec34ca127342488c60e9d8c7db06ab363276931b8f`。

7 组容器验收通过：

1. Compose 启动、健康检查、node 普通用户、cap_drop=ALL / no-new-privileges、随机 loopback 端口。
2. 生产 Web、JS 静态资源和 API 同源可访问。
3. 容器内假模型的真实 HTTP 流、SQLite 写入、目录 0700 / 数据库及凭证 0600。
4. 正常重启，完整会话与模型设置保持不变。
5. 停服后完整复制原卷到独立新卷，恢复会话、配置与凭证引用。
6. 持久化部分文字后真正 SIGKILL 容器，等待陈旧锁过期再启动，Run 标记 interrupted，保留文字且不自动调用模型。
7. 恢复后删除会话，检查日志不含假密钥；清理测试容器、网络、原始卷与恢复卷。

恢复后不再挂载的原始测试卷不会被 Compose 自动清理，因此脚本显式跟踪并删除自己创建的剩余卷，已补跑验证。测试没有挂载或复制用户真实数据 / 凭证。机器可读结果位于 `.cache/acceptance/docker.json`，构建日志在 `.cache/acceptance/docker-build.log`。

本机 3001 服务已在无活动 Run 时重启到修正版；验收会话快照 SHA-256 前后一致，配置 revision 仍为 2，结果在 `.cache/acceptance/restart.json`。原始 HTML 设计交付物保持不变。远程 CI、linux/amd64 和其他服务商没有本轮执行证据。

## 知识维护

检查根、apps、server、scripts、tests 和 docs AGENTS；补充 server 锁路径、tests / scripts 独立验收与故障注入约定。同步 STATUS、测试说明、维护文档、有效架构及路线。模块依赖和 API / 数据 schema 没有变化，不新增协议版本或 ADR。

入口：[当前状态](../STATUS.md)、[测试说明](../development/testing.md)、[维护说明](../development/setup.md)。
