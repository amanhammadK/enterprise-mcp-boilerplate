FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build --if-present

FROM node:20-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 appuser && adduser --system --uid 1001 appuser
COPY --from=builder /app .
USER appuser
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD node -e "require('http').get('http://localhost:8080/health', r => process.exit(r.statusCode===200?0:1))" || exit 1
CMD ["node", "index.js"]
