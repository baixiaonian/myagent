# 开发环境与命令

推荐 Node.js 24 LTS（.nvmrc / .node-version），pnpm 11.7.0。首次安装依赖：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Web 默认由 Vite 提供 loopback 开发地址；以终端输出为准。服务端三个入口仅打印骨架状态，没有监听 HTTP、执行任务或加载凭证。

| 命令 | 行为 |
| --- | --- |
| pnpm dev | Web 静态骨架页 |
| pnpm dev:server / dev:cli / dev:worker | tsx watch 对应占位入口 |
| pnpm typecheck | 检查并增量编译工作区，再检查工程工具与测试类型；产生被忽略的缓存与 dist |
| pnpm dev:types | 持续编译工作区；后续修改被其他包依赖的源码时另开终端运行 |
| pnpm build | 编译工作区并打包 Web |
| pnpm lint / format | Biome 检查 / 格式整理新工程文件 |
| pnpm check:architecture | 包依赖、源码导入与循环检查 |
| pnpm check:docs | 必需文档、局部规则和相对链接检查 |
| pnpm test | 工程检查器回归测试 |
| pnpm verify | 完整工程检查与构建 |

安装脚本 allowBuilds 当前仅允许构建工具 esbuild。新增需要安装脚本的依赖时审查后更新 pnpm-workspace.yaml。当前无 API key、数据库或 Docker 前置条件。

所有包 private，未配置发布或远程仓库。未来运行数据放在仓库外；不要把研究快照或真实业务数据加入 workspace。
