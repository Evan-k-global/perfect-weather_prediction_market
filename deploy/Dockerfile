FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    clang \
    cmake \
    libssl-dev \
    pkg-config \
    python3 \
    ca-certificates \
    curl \
    openssl \
  && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup
ENV CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:${PATH}

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable

RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
COPY public ./public
COPY examples ./examples
COPY external/zk-verify-poc /opt/zk-verify-poc
COPY deploy/start-render.sh /app/deploy/start-render.sh
COPY deploy/start-oracle-worker.sh /app/deploy/start-oracle-worker.sh
COPY deploy/start-tx-prover.sh /app/deploy/start-tx-prover.sh
COPY deploy/demo-daily-threshold-markets.seed.json /app/deploy/demo-daily-threshold-markets.seed.json

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm fast-node-cache:build
RUN pnpm fast-cache:build
RUN cargo build --manifest-path /opt/zk-verify-poc/tlsnotary/Cargo.toml
RUN chmod +x /app/deploy/start-render.sh /app/deploy/start-oracle-worker.sh /app/deploy/start-tx-prover.sh

ENV NODE_ENV=production
ENV ZKVERIFY_POC_ROOT=/opt/zk-verify-poc

CMD ["/app/deploy/start-render.sh"]
