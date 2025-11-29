# Environment Variables Configuration

This document lists all environment variables used by the WhatsApp Multi-Docker Automation System.

## Quick Start

Create a `.env` file in the project root with the following variables:

```bash
# Copy this content to .env file
# Modify values as needed for your environment
```

---

## Database - PostgreSQL

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `postgres` | PostgreSQL hostname |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `whatsapp_automation` | Database name |
| `DB_USER` | `whatsapp` | Database username |
| `DB_PASSWORD` | `whatsapp123` | Database password |
| `DATABASE_URL` | - | Full connection string (alternative to individual vars) |

Example:
```bash
DB_HOST=postgres
DB_PORT=5432
DB_NAME=whatsapp_automation
DB_USER=whatsapp
DB_PASSWORD=whatsapp123
DATABASE_URL=postgres://whatsapp:whatsapp123@postgres:5432/whatsapp_automation
```

---

## Cache & Queue - Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `redis` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_URL` | - | Full Redis URL |
| `REDIS_PASSWORD` | - | Redis password (optional) |

Example:
```bash
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_URL=redis://redis:6379
```

---

## Master Server

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `production` | Node environment |
| `PORT` | `5000` | Master server port |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `API_KEY` | - | API key for authentication |
| `JWT_SECRET` | - | Secret for JWT tokens |
| `CORS_ORIGINS` | - | Allowed CORS origins (comma-separated) |

Example:
```bash
NODE_ENV=production
PORT=5000
LOG_LEVEL=info
API_KEY=your-secure-api-key-here
JWT_SECRET=your-jwt-secret-here
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

---

## Worker Configuration

### Worker URLs (for Master Server)

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_1_URL` | `http://worker-1:3001` | Worker 1 (US) URL |
| `WORKER_2_URL` | `http://worker-2:3001` | Worker 2 (IL) URL |
| `WORKER_3_URL` | `http://worker-3:3001` | Worker 3 (GB) URL |
| `WORKER_US_URL` | - | Alias for US worker |
| `WORKER_IL_URL` | - | Alias for IL worker |
| `WORKER_GB_URL` | - | Alias for GB worker |

### Worker Instance Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_ID` | `worker-1` | Unique worker identifier |
| `WORKER_PORT` | `3001` | Worker HTTP port |
| `DEVICE_SEED` | - | **CRITICAL**: Unique seed for device fingerprint |
| `PROXY_COUNTRY` | `US` | Country code for this worker (US, IL, GB) |
| `MASTER_URL` | `http://master:5000` | Master server URL |

**Worker 1 (USA):**
```bash
WORKER_ID=worker-1
WORKER_PORT=3001
DEVICE_SEED=unique-seed-worker-1-usa-abc123
PROXY_COUNTRY=US
```

**Worker 2 (Israel):**
```bash
WORKER_ID=worker-2
WORKER_PORT=3001
DEVICE_SEED=unique-seed-worker-2-israel-xyz789
PROXY_COUNTRY=IL
```

**Worker 3 (UK):**
```bash
WORKER_ID=worker-3
WORKER_PORT=3001
DEVICE_SEED=unique-seed-worker-3-uk-qwe456
PROXY_COUNTRY=GB
```

---

## Anti-Ban Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_DELAY_MS` | `1000` | Minimum delay between messages (ms) |
| `MAX_DELAY_MS` | `7000` | Maximum delay between messages (ms) |
| `SHORT_BREAK_INTERVAL` | `10` | Messages before short break |
| `SHORT_BREAK_MIN_MS` | `30000` | Minimum short break duration (ms) |
| `SHORT_BREAK_MAX_MS` | `120000` | Maximum short break duration (ms) |
| `LONG_BREAK_INTERVAL` | `50` | Messages before long break |
| `LONG_BREAK_MIN_MS` | `300000` | Minimum long break (5 min) |
| `LONG_BREAK_MAX_MS` | `900000` | Maximum long break (15 min) |
| `MAX_MESSAGES_PER_DAY` | `100` | Max messages per account per day |
| `MAX_MESSAGES_PER_HOUR` | `20` | Max messages per account per hour |
| `TRUST_SCORE_MIN` | `20` | Minimum trust score before blocking |
| `TRUST_SCORE_WARNING` | `50` | Trust score warning threshold |

Example:
```bash
MIN_DELAY_MS=1000
MAX_DELAY_MS=7000
SHORT_BREAK_INTERVAL=10
LONG_BREAK_INTERVAL=50
MAX_MESSAGES_PER_DAY=100
```

---

## Proxy Configuration (Optional)

For each country, configure a proxy server:

| Variable | Description |
|----------|-------------|
| `PROXY_US_HOST` | US proxy hostname |
| `PROXY_US_PORT` | US proxy port |
| `PROXY_US_USER` | US proxy username |
| `PROXY_US_PASS` | US proxy password |
| `PROXY_IL_HOST` | Israel proxy hostname |
| `PROXY_IL_PORT` | Israel proxy port |
| `PROXY_IL_USER` | Israel proxy username |
| `PROXY_IL_PASS` | Israel proxy password |
| `PROXY_GB_HOST` | UK proxy hostname |
| `PROXY_GB_PORT` | UK proxy port |
| `PROXY_GB_USER` | UK proxy username |
| `PROXY_GB_PASS` | UK proxy password |

Example:
```bash
PROXY_US_HOST=us.proxy.example.com
PROXY_US_PORT=8080
PROXY_US_USER=proxyuser
PROXY_US_PASS=proxypass
```

---

## Webhook Configuration (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_URL` | - | URL to receive webhook events |
| `WEBHOOK_SECRET` | - | Secret for webhook signature |
| `WEBHOOK_EVENTS` | - | Events to send (comma-separated) |

Available events:
- `message.sent`
- `message.delivered`
- `message.read`
- `message.failed`
- `account.connected`
- `account.disconnected`

Example:
```bash
WEBHOOK_URL=https://your-server.com/webhook
WEBHOOK_SECRET=your-webhook-secret
WEBHOOK_EVENTS=message.sent,message.delivered,message.failed
```

---

## Monitoring (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `SENTRY_DSN` | - | Sentry DSN for error tracking |
| `PROMETHEUS_ENABLED` | `false` | Enable Prometheus metrics |
| `PROMETHEUS_PORT` | `9090` | Prometheus metrics port |

---

## Development

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | `false` | Enable debug mode |
| `VERBOSE_LOGGING` | `false` | Enable verbose logging |

---

## Complete Example .env File

```bash
# ============================================
# WhatsApp Multi-Docker Automation System
# ============================================

# Database
DB_HOST=postgres
DB_PORT=5432
DB_NAME=whatsapp_automation
DB_USER=whatsapp
DB_PASSWORD=whatsapp123
DATABASE_URL=postgres://whatsapp:whatsapp123@postgres:5432/whatsapp_automation

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_URL=redis://redis:6379

# Master Server
NODE_ENV=production
PORT=5000
LOG_LEVEL=info

# Worker URLs
WORKER_1_URL=http://worker-1:3001
WORKER_2_URL=http://worker-2:3001
WORKER_3_URL=http://worker-3:3001

# Anti-Ban
MIN_DELAY_MS=1000
MAX_DELAY_MS=7000
SHORT_BREAK_INTERVAL=10
LONG_BREAK_INTERVAL=50
MAX_MESSAGES_PER_DAY=100

# Development
DEBUG=false
```

---

## Security Notes

1. **Never commit `.env` files** to version control
2. **Use strong, unique `DEVICE_SEED`** values for each worker
3. **Change default passwords** in production
4. **Use HTTPS** for webhook URLs
5. **Rotate API keys** periodically

