# Self-hosted production image for the HackerAI web app.
# Build:  docker build -t hackerai-app .
# NEXT_PUBLIC_* values are inlined into the client bundle, so pass them as
# build args (Dokploy forwards compose build args from the service environment).

FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/desktop/package.json ./packages/desktop/
COPY packages/local/package.json ./packages/local/
COPY packages/workos-authkit-nextjs/package.json ./packages/workos-authkit-nextjs/
COPY packages/workos-node/package.json ./packages/workos-node/
COPY packages/workos-widgets/package.json ./packages/workos-widgets/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Sources + dependencies. Also the image of the compose `setup` job, which
# deploys ./convex to the self-hosted Convex backend.
FROM node:22-slim AS source
RUN corepack enable
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

FROM source AS build
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_CONVEX_URL
ENV NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL \
    NEXT_PUBLIC_CONVEX_URL=$NEXT_PUBLIC_CONVEX_URL \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
# `next build` directly: the repo's `pnpm build` also uploads PostHog sourcemaps.
RUN pnpm exec next build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN useradd --system --uid 1001 nextjs
COPY --from=build --chown=nextjs /app/.next/standalone ./
COPY --from=build --chown=nextjs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs /app/public ./public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
