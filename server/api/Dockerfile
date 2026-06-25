FROM node:20-slim
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY shared ./shared
COPY api/src ./src
COPY worker/assets/fonts ./assets/fonts
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
