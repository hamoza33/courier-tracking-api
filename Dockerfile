# syntax=docker/dockerfile:1.7

# ---------- build stage ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- runtime stage ----------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Install system dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libxshmfence1 libglib2.0-0 \
    libx11-xcb1 libxfixes3 libxext6 libx11-6 libxcb1 libxrender1 \
    libfontconfig1 libdbus-1-3 libexpat1 libatspi2.0-0 \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Install Playwright Chromium browser
RUN npx playwright install chromium

COPY --from=build /app/dist ./dist

ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080

CMD ["node", "dist/server.js"]
