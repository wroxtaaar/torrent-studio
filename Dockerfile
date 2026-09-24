FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/package*.json ./
# tsx is a devDependency but is the runtime for server.ts in this image.
# Install dev dependencies in the runtime image so startup does not invoke
# npx to download tsx on every container restart.
RUN npm ci --include=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src ./src

RUN mkdir -p /app/storage/downloads /app/storage/temp

EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "server.ts"]
