# 1073 Parts — production image. Data (database, photos, part files) lives on a mounted volume at /data.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV DATA_DIR=/data \
    PORT=3000 \
    TRUST_PROXY=1
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "server/start.js"]
