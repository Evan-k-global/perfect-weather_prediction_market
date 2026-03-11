FROM node:20-bookworm

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY public ./public
COPY examples ./examples

RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV NODE_ENV=production

CMD ["pnpm", "marketplace:serve"]
