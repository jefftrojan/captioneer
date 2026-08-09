# --- Stage 1: build the web app ---
FROM node:22-bookworm-slim AS webbuild
WORKDIR /app/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# --- Stage 2: runtime (Node server + ffmpeg, serves the built web app) ---
FROM node:22-bookworm-slim
# ffmpeg for audio decode/extract; yt-dlp (self-contained binary) for URL fetch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl python3 \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/package*.json ./
RUN npm install
COPY server/ ./

COPY --from=webbuild /app/web/dist /app/web/dist

ENV STATIC_DIR=/app/web/dist
ENV HF_HOME=/cache
ENV PORT=8787
EXPOSE 8787
CMD ["npm", "run", "start"]
