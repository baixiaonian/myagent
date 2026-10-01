# ADR-0022：HTML 交互预览与原文编辑隔离

状态：已采纳。

公开插件生成的销售报表在独立浏览器完整显示，MyAgent 右侧却只有占位符。原静态预览移除所有文档脚本，导致数据初始化、图表和筛选都没有运行；文件本身没有丢失。

默认增加隔离交互预览，保留自包含 HTML 的内嵌脚本和事件。文字编辑继续用静态预览和原文偏移，两种入口分别建立 iframe，交互态不暴露选区、保存或应用 API 桥。筛选和页面运行不能自动变成文件修改。

两个 iframe 均只有 allow-scripts，没有 allow-same-origin。可信外层只承载 Blob 页面，frame-src 限制内层导航目的地；内层 CSP 再禁止网络、嵌套页面、Worker、表单和外部资源。仅依赖内层 connect-src 不够，因为它不约束 location 导航。副本通过纯解析器生成，原文件不被清洗或重新序列化。没有放宽 Agent 的命令、资源或执行模式权限。

首版支持自包含页面；外部 CDN、fetch 数据和相对路径资源不自动代理，不访问项目文件系统。浏览器隔离不等于为脚本提供 CPU/内存配额，不承诺任意恶意脚本不会造成页面卡顿。

验证必须进入实际文档面板，覆盖动态数据、过滤器、内联事件、伪造选区消息、宿主读取、网络请求、弹窗、表单、自身导航及源文件不变。技术边界参考 [iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe) 和 [CSP frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src)。协议见 [文档工作区](../protocols/documents-v1.md)。
