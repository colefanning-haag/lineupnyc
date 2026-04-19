FROM node:20-bookworm-slim

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN chmod +x scripts/docker-entrypoint.sh

EXPOSE 3000
ENV NODE_ENV=production
ENV DB_PATH=/data/spotlight.db

# Run via sh so the script always executes; CMD args are appended (see Docker exec form).
ENTRYPOINT ["/bin/sh", "/app/scripts/docker-entrypoint.sh"]
CMD ["npm", "start"]
