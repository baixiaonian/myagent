# 来源卡：SQLite WAL

采集核验日：2026-09-29。以下为依据官方文档整理的事实材料；不是目标文章，也不代表任何真实生产事故。

S1：https://sqlite.org/wal.html ，重点 2.1/2.2/2.3、6、9 节。SQLite 官方代码与文档为公有领域，说明：https://sqlite.org/copyright.html 。
S2：https://sqlite.org/isolation.html ，snapshot isolation 与写事务章节。
S3：https://docs.python.org/3/library/sqlite3.html ，连接 timeout、事务控制与异常说明。

- 常规回滚日志保存修改前页面；WAL 将修改追加到独立文件。提交记录标记事务完成，稍后 checkpoint 才回写主数据库。
- 读事务按启动时的 end mark 读取一致快照。同一 WAL 仍只有一个写者；不能从“读写并行”推出“并发多写”。
- 默认自动 checkpoint 阈值通常为 1000 页，可配置。长读事务可能令 checkpoint 无法越过仍被读取的页面版本。
- SQLITE_BUSY 并未因 WAL 消失；锁等待超时和读事务升级等情况需要单独分析。适当等待可缓解竞争，不能解决无限持锁。
- 同机 WAL 通常使用共享内存 wal-index；跨机器网络文件系统不是该模式的适用部署。
- synchronous 的配置涉及断电持久性，不能将改变它当作解决竞争的无代价方案。
- Python 两个连接必须指向同一个临时文件；一个连接 BEGIN IMMEDIATE 后不提交，另一个短 timeout 写入，可稳定演示写锁竞争。不要使用两个独立的 :memory: 数据库。
