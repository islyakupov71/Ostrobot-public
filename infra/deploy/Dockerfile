# Многоступенчатая сборка монорепозитория.
#
# Зависимости ставятся отдельным слоем до копирования исходников: правка кода
# не должна заново тянуть весь npm. Финальные образы содержат только
# собранный JS и продакшен-зависимости.

FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/sheets/package.json packages/sheets/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r build

FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/api
EXPOSE 3000
# Пользователь node вместо root: контейнер не должен работать с лишними правами.
USER node
CMD ["node", "dist/index.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker ./apps/worker
WORKDIR /app/apps/worker
USER node
CMD ["node", "dist/index.js"]
