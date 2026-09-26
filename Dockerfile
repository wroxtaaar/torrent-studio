FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npm install --no-save --package-lock=false webtorrent@3.0.21

COPY . .
RUN npm run build

FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY --from=frontend-build /app/dist ./dist

RUN mkdir -p /app/storage/downloads /app/storage/meta /app/storage/stream-cache /app/storage/hls-cache

EXPOSE 3000
CMD ["python", "-m", "backend.main"]
