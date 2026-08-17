FROM node:22-alpine AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force


FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    DATA_FILE=/app/runtime/data.json

WORKDIR /app

RUN mkdir -p /app/runtime && chown -R node:node /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 4173
VOLUME ["/app/runtime"]

HEALTHCHECK --interval=10s --timeout=4s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "src/server.js"]
