FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --include=optional
# The server runs through tsx, so make the ARM64 esbuild binary explicit in the image.
RUN npm install --no-save --package-lock=false --include=optional --force @esbuild/linux-arm64@0.28.2
RUN test -x node_modules/@esbuild/linux-arm64/bin/esbuild
RUN npm install --no-save --package-lock=false webtorrent@3.0.21

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
RUN npm ci --include=dev --include=optional
# Keep the ARM64 esbuild binary from the ARM64 build stage.
COPY --from=build /app/node_modules/@esbuild/linux-arm64 ./node_modules/@esbuild/linux-arm64
RUN test -x node_modules/@esbuild/linux-arm64/bin/esbuild
RUN npm install --no-save --include=optional webtorrent@3.0.21

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/src ./src

RUN mkdir -p /app/storage/downloads /app/storage/temp

EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "server.ts"]
