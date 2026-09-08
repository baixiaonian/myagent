# 本地服务

继承 [应用约定](../AGENTS.md)。bootstrap 是唯一组合根，接入 application / adapters；main 只负责启动与关闭。Host / Origin 校验、JSON 严格校验和安全错误提示不可绕过。默认 loopback，容器仅向宿主 loopback 映射。

日志不包含正文、凭证、请求 URL 或上游异常对象。请求处理的日志测试必须覆盖恶意上游回显密钥。SSE 断连不能取消 Run；preClose 结束 SSE 后标记活动运行中断，onClose 关闭库并释放目录锁。同一数据目录只允许一个服务器进程。

协议、数据迁移或启动配置变化，更新 [API 文档](../../docs/protocols/chat-v1.md)、[维护说明](../../docs/development/setup.md)、STATUS 和历史。

进程锁存放于数据目录内部 `server.lock`，不能依赖数据卷父目录可写。启动也检查旧版本的目录旁锁；升级需先停止旧进程。锁路径变化必须覆盖普通用户和只读父目录的回归测试。
