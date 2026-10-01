# 本地聊天产品镜像：构建阶段编译工作区与原生 SQLite 依赖，运行阶段用普通用户启动统一服务。
# 用户数据仅写入 /data 持久卷；本文件不打包宿主凭证或数据库。
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
# 构建时固定 pnpm 版本，避免宿主全局工具影响依赖解析。
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
RUN printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/80network-retries \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
# pnpm 的工作区不支持 prune --prod：重新安装纯运行时依赖。
RUN find . -type d -name node_modules -prune -exec rm -rf '{}' + && pnpm install --prod --frozen-lockfile

# 最终镜像不需要编译工具链；由 node 用户运行，数据卷权限在降权前建立。
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production MYAGENT_CONTAINER=1 MYAGENT_DATA_DIR=/data MYAGENT_WORKSPACE_ROOT=/workspaces MYAGENT_SKILL_ROOT=/skills MYAGENT_HOOK_ROOT=/hooks PORT=3000
WORKDIR /app
# 安装原生工具依赖；标准模式必须通过功能探测，嵌套隔离不可用时拒绝；显式完全访问不使用内层沙箱。
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat ripgrep python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data /workspaces /skills /hooks && chown node:node /data /workspaces /skills /hooks && chmod 700 /data /workspaces /skills /hooks
USER node
VOLUME ["/data", "/workspaces", "/skills", "/hooks"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
