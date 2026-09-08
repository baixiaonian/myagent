FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
RUN printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::ForceIPv4 "true";\n' > /etc/apt/apt.conf.d/80network-retries \
    && apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
# pnpm 的工作区不支持 prune --prod：重新安装纯运行时依赖。
RUN find . -type d -name node_modules -prune -exec rm -rf '{}' + && pnpm install --prod --frozen-lockfile

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production MYAGENT_CONTAINER=1 MYAGENT_DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
