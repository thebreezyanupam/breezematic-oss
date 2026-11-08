FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ffmpeg drives the mix pass; the libx* set is what Remotion's headless Chrome
# needs to render the picture.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libdbus-1-3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libasound2 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libpango-1.0-0 \
      libcairo2 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json remotion.config.ts ./
COPY src ./src
COPY public ./public
COPY fixtures ./fixtures

RUN pnpm typecheck

ENTRYPOINT ["pnpm", "cli"]
CMD ["doctor"]
