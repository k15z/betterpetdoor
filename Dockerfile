# syntax=docker/dockerfile:1

FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/betterpetdoor ./cmd/betterpetdoor

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=backend /out/betterpetdoor /app/betterpetdoor
COPY --from=web /src/web/dist /app/web/dist
ENV BETTERPETDOOR_ADDR=:8080 \
    BETTERPETDOOR_DB_PATH=/data/betterpetdoor.db \
    BETTERPETDOOR_WEB_DIR=/app/web/dist \
    BETTERPETDOOR_SECURE_COOKIE=true
EXPOSE 8080
ENTRYPOINT ["/app/betterpetdoor"]
