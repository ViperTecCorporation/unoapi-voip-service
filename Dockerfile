FROM node:24-bookworm-slim AS builder

ENV NODE_ENV=development

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ./package.json ./package.json
COPY ./package-lock.json ./package-lock.json

RUN npm ci

COPY ./src ./src
COPY ./tsconfig.json ./tsconfig.json
COPY ./.env.example ./.env.example
COPY ./README.md ./README.md

RUN npm run build

FROM node:24-bookworm-slim

LABEL \
  maintainer="Clairton Rodrigo Heinzen <clairton.rodrigo@gmail.com>" \
  org.opencontainers.image.title="Unoapi VoIP Service" \
  org.opencontainers.image.description="Servico auxiliar de VoIP para integrar UnoAPI ao WhatsApp VoIP WASM" \
  org.opencontainers.image.authors="Clairton Rodrigo Heinzen <clairton.rodrigo@gmail.com>" \
  org.opencontainers.image.vendor="https://uno.ltd"

ENV NODE_ENV=production

RUN groupadd -r u && useradd -r -g u u
WORKDIR /home/u/app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/README.md ./README.md
COPY --from=builder /app/.env.example ./.env.example

USER u

EXPOSE 3097

ENTRYPOINT ["node", "dist/app.js"]
