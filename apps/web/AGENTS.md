# Web 聊天工作台

继承 [应用约定](../AGENTS.md)。只通过 SDK 访问后端；不能存储已保存密钥、直接调用模型或接触数据库。密钥输入仅用于首次保存 / 更换，保存成功后清空。

保持 IME-safe Enter、Shift+Enter、每会话草稿、停止生成、主动上滚不追尾和移动侧栏行为。刷新只断开订阅，不取消运行。Markdown 不执行原始 HTML、不加载图片。重新生成候选失败要继续展示原完整答案；事件和快照按 cursor 去重。

改交互时更新 tests/e2e、[协议](../../docs/protocols/chat-v1.md)、STATUS 和历史。Vite 默认代理本地 3000，Web 默认 5173；PORT / MYAGENT_WEB_PORT 可覆盖并同步开发代理。生产资源由 server 托管。不要自动发布公共网站。
