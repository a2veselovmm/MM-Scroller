FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    fontconfig \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY shared ./shared
COPY scripts/fetch-fonts.mjs ./scripts/fetch-fonts.mjs
RUN node scripts/fetch-fonts.mjs /app/assets/fonts
COPY worker/src ./src
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
