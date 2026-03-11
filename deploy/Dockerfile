FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cargo \
    clang \
    cmake \
    libssl-dev \
    pkg-config \
    python3 \
    ca-certificates \
    openssl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY public ./public
COPY examples ./examples
COPY external/zk-verify-poc /opt/zk-verify-poc
COPY deploy/start-render.sh /app/deploy/start-render.sh

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN cargo build --manifest-path /opt/zk-verify-poc/tlsnotary/Cargo.toml
RUN chmod +x /app/deploy/start-render.sh

ENV NODE_ENV=production
ENV ZKVERIFY_POC_ROOT=/opt/zk-verify-poc

CMD ["/app/deploy/start-render.sh"]
