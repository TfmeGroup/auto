# TFME Auto — container image. Three runnable targets from one build:
#   web     : the Next.js application (default)
#   worker  : the background job worker
#   migrate : applies database migrations and syncs reference data, then exits
#
#   docker build --target web    -t tfme-auto-web .
#   docker build --target worker -t tfme-auto-worker .
#   docker build --target migrate -t tfme-auto-migrate .

FROM node:22-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# Prisma client is generated code (not committed). No database is needed to build.
RUN npx prisma generate && npx next build

# ── migrate: schema owner credentials are injected only for this one-shot job ──
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["npx", "tsx", "scripts/migrate.ts"]

# ── worker: same code, different entrypoint ──
FROM build AS worker
ENV NODE_ENV=production
USER node
CMD ["npx", "tsx", "src/server/jobs/worker-cli.ts"]

# ── web: minimal standalone server, non-root ──
FROM base AS web
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
