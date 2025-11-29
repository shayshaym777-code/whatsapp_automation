############################
# STEP 1: Build Go binary
############################
FROM golang:1.24-alpine AS builder

# Install build dependencies for CGO (SQLite requires CGO)
RUN apk update && apk add --no-cache \
    gcc \
    musl-dev \
    gcompat \
    git \
    sqlite-dev

WORKDIR /app

# Copy go mod files first for caching
COPY go.mod go.sum* ./
RUN go mod download

# Copy source code
COPY . .

# Build with CGO enabled for SQLite support
RUN CGO_ENABLED=1 GOOS=linux go build -a -ldflags="-w -s -linkmode external -extldflags '-static'" -o /worker ./cmd/worker

############################
# STEP 2: Production image
############################
FROM alpine:3.19

# Install runtime dependencies
RUN apk add --no-cache \
    ffmpeg \
    tzdata \
    ca-certificates \
    sqlite

# Create non-root user for security
RUN adduser -D -g '' -u 1000 appuser

WORKDIR /app

# Copy binary from builder
COPY --from=builder /worker /app/worker

# Create data directories with proper permissions
RUN mkdir -p /data/sessions /data/qrcodes /data/logs /data/media && \
    chown -R appuser:appuser /data /app

# Also create local sessions dir for development
RUN mkdir -p /app/sessions && chown -R appuser:appuser /app/sessions

USER appuser

# Environment variables
ENV WORKER_ID="worker-1"
ENV WORKER_PORT=3001
ENV DEVICE_SEED="default-seed"
ENV PROXY_COUNTRY="US"
ENV MASTER_URL="http://master:5000"

# Expose the worker port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${WORKER_PORT}/health || exit 1

# Run the worker
ENTRYPOINT ["/app/worker"]
