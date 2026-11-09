FROM node:24.14.0-bookworm-slim
WORKDIR /app
RUN npm install --global pnpm@10.32.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/agentzero/package.json packages/agentzero/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG PREBUILT_WEB=0
RUN if [ "$PREBUILT_WEB" = "1" ]; then test -f apps/web/dist/index.html; else pnpm -r --workspace-concurrency=1 build; fi
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@agentzero/api", "start"]
