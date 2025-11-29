# 🚀 פקודה ל-Cursor - שלב 1 מתוך 10

## העתק את כל הטקסט הזה ושלח ל-Cursor:

---

```
=============================================================
PROJECT: WhatsApp Multi-Docker Automation System
STAGE: 1/10 - Setup & Foundation
LANGUAGE: Generate code with English comments, UI can support Hebrew
=============================================================

I'm building a WhatsApp automation system with multiple Docker workers.
Each worker handles 50 WhatsApp accounts with unique device fingerprints.

## PROJECT CONTEXT

I have uploaded:
1. go-whatsapp-base/ - Base Go WhatsApp library (whatsmeow-based)
2. docs/ folder with critical documentation:
   - AntiBan_Algorithm_100_1000_Messages.txt - Anti-ban timing & rules
   - CRITICAL_RULES_FOR_DEVELOPER.txt - Proxy matching rules
   - PHONE_TOKEN_PROXY_RELATIONSHIP.txt - Phone-Proxy requirements
   - COMPLETE_WORKFLOW_QR_TO_SERVER.txt - Full QR workflow
3. SYSTEM_SPECIFICATION.md - Complete architecture document

## ARCHITECTURE OVERVIEW

```
                         ┌──────────────────┐
                         │    Dashboard     │
                         │   (React:8080)   │
                         └────────┬─────────┘
                                  │
                         ┌────────▼─────────┐
                         │  Master Server   │
                         │  (Node.js:5000)  │
                         │  ┌────────────┐  │
                         │  │Load Balancer│  │
                         │  │ Anti-Ban   │  │
                         │  │ Msg Queue  │  │
                         │  └────────────┘  │
                         └────────┬─────────┘
                                  │
           ┌──────────────────────┼──────────────────────┐
           │                      │                      │
    ┌──────▼──────┐       ┌──────▼──────┐       ┌──────▼──────┐
    │  Worker-1   │       │  Worker-2   │       │  Worker-N   │
    │  (Go:3001)  │       │  (Go:3002)  │       │  (Go:300N)  │
    │  50 accounts│       │  50 accounts│       │  50 accounts│
    │  US Proxy   │       │  IL Proxy   │       │  UK Proxy   │
    │  Unique FP  │       │  Unique FP  │       │  Unique FP  │
    └─────────────┘       └─────────────┘       └─────────────┘
```

=============================================================
TASK FOR STAGE 1: Create Complete Project Structure
=============================================================

Create this folder structure with ALL files:

```
whatsapp-automation/
│
├── master-server/                    # Node.js Master Server
│   ├── src/
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── accounts.js       # Account CRUD + connect/disconnect
│   │   │   │   ├── messages.js       # Send single/bulk messages
│   │   │   │   ├── workers.js        # Worker management
│   │   │   │   ├── campaigns.js      # Campaign management
│   │   │   │   └── health.js         # Health checks
│   │   │   └── middleware/
│   │   │       ├── auth.js           # JWT/API key auth
│   │   │       ├── rateLimit.js      # Rate limiting
│   │   │       └── validator.js      # Request validation
│   │   ├── services/
│   │   │   ├── LoadBalancer.js       # Distribute to workers
│   │   │   ├── AntiBanEngine.js      # Anti-ban logic
│   │   │   ├── MessageQueue.js       # Redis queue
│   │   │   ├── WorkerManager.js      # Track worker health
│   │   │   ├── AccountManager.js     # Account operations
│   │   │   └── ProxyManager.js       # Proxy rotation
│   │   ├── models/
│   │   │   ├── Account.js
│   │   │   ├── Worker.js
│   │   │   ├── Message.js
│   │   │   └── Campaign.js
│   │   ├── config/
│   │   │   ├── database.js           # PostgreSQL config
│   │   │   ├── redis.js              # Redis config
│   │   │   └── index.js              # Main config
│   │   ├── utils/
│   │   │   ├── logger.js             # Winston logger
│   │   │   └── helpers.js            # Utility functions
│   │   └── app.js                    # Express app entry
│   ├── package.json
│   ├── Dockerfile
│   └── .env.example
│
├── worker/                           # Go Worker Service
│   ├── cmd/
│   │   └── worker/
│   │       └── main.go               # Entry point
│   ├── internal/
│   │   ├── api/
│   │   │   ├── handlers.go           # HTTP handlers
│   │   │   └── router.go             # Mux router
│   │   ├── whatsapp/
│   │   │   ├── client.go             # WhatsApp client wrapper
│   │   │   ├── session.go            # Session management
│   │   │   └── messaging.go          # Send messages
│   │   ├── fingerprint/
│   │   │   └── generator.go          # Device fingerprint generation
│   │   ├── proxy/
│   │   │   └── manager.go            # Proxy configuration
│   │   └── antiban/
│   │       └── engine.go             # Anti-ban delays & variations
│   ├── pkg/
│   │   └── config/
│   │       └── config.go             # Configuration loading
│   ├── go.mod
│   ├── go.sum
│   ├── Dockerfile
│   └── .env.example
│
├── dashboard/                        # React Dashboard (placeholder)
│   ├── src/
│   │   └── App.jsx
│   ├── public/
│   │   └── index.html
│   ├── package.json
│   └── Dockerfile
│
├── docker/
│   ├── docker-compose.yml            # Main compose file
│   ├── docker-compose.dev.yml        # Development overrides
│   └── nginx.conf                    # Nginx reverse proxy
│
├── database/
│   └── init.sql                      # PostgreSQL schema
│
├── scripts/
│   ├── start.sh                      # Start all services
│   ├── stop.sh                       # Stop all services
│   └── add-worker.sh                 # Add new worker
│
└── .env.example                      # Root environment
```

=============================================================
FILE REQUIREMENTS - DETAILED
=============================================================

### 1. master-server/package.json
```json
{
  "name": "whatsapp-master-server",
  "version": "1.0.0",
  "main": "src/app.js",
  "scripts": {
    "start": "node src/app.js",
    "dev": "nodemon src/app.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.3",
    "ioredis": "^5.3.2",
    "cors": "^2.8.5",
    "helmet": "^7.1.0",
    "winston": "^3.11.0",
    "dotenv": "^16.3.1",
    "uuid": "^9.0.1",
    "axios": "^1.6.2",
    "express-rate-limit": "^7.1.5",
    "joi": "^17.11.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
```

### 2. worker/go.mod
Base it on the go-whatsapp-base/src/go.mod but add:
- github.com/gorilla/mux (for HTTP routing)
- Keep all whatsmeow dependencies

### 3. docker/docker-compose.yml
Include these services:
- postgres:15-alpine (port 5432)
- redis:7-alpine (port 6379)
- master (port 5000, depends on postgres & redis)
- worker-1 (port 3001, WORKER_ID=worker-1, PROXY_COUNTRY=US)
- worker-2 (port 3002, WORKER_ID=worker-2, PROXY_COUNTRY=IL)
- worker-3 (port 3003, WORKER_ID=worker-3, PROXY_COUNTRY=GB)

CRITICAL: Each worker MUST have different:
- WORKER_ID
- DEVICE_SEED (unique string for fingerprint)
- PROXY_COUNTRY
- Port mapping

### 4. database/init.sql
Create tables:
- workers (id, port, host, proxy_country, max_accounts, status, healthy_accounts, last_heartbeat)
- accounts (id, phone_number, session_token, country, proxy_ip, proxy_port, proxy_username, proxy_password, worker_id, status, trust_score, messages_sent, messages_failed)
- messages (id UUID, from_phone, to_phone, message_text, status, worker_id, sent_at, error_message)
- campaigns (id, name, message_template, target_phones[], status, messages_sent)
- proxies (id, ip, port, username, password, country, status, assigned_account_id)

### 5. worker/internal/fingerprint/generator.go
Generate UNIQUE device fingerprint per worker:
- DeviceID (16 char hex)
- MACAddress (XX:XX:XX:XX:XX:XX format)
- ComputerName (DESKTOP-XXXXXX format)
- UserAgent (random from list)
- ScreenResolution
- Timezone (based on PROXY_COUNTRY)
- Language (based on PROXY_COUNTRY)

The fingerprint must be DETERMINISTIC per WORKER_ID (same worker = same fingerprint always)

### 6. .env.example files
Root .env.example:
```
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=whatsapp_automation
DB_USER=whatsapp
DB_PASSWORD=your_secure_password

# Redis
REDIS_URL=redis://localhost:6379

# Security
JWT_SECRET=your_jwt_secret_here
ADMIN_API_KEY=your_admin_api_key

# Proxy Provider (Oxylabs)
OXYLABS_USER=your_oxylabs_username
OXYLABS_PASS=your_oxylabs_password

# Master Server
MASTER_PORT=5000

# Worker defaults
DEFAULT_MAX_ACCOUNTS=50
```

=============================================================
CRITICAL RULES (From Documentation)
=============================================================

1. PROXY COUNTRY MUST MATCH PHONE COUNTRY
   - Phone +1 (USA) → Must use USA proxy
   - Phone +972 (Israel) → Must use Israel proxy
   
2. PROXY MUST BE SET BEFORE QR SCAN
   - Configure proxy first
   - Then open WhatsApp
   - Then scan QR
   
3. EACH WORKER = UNIQUE DEVICE
   - Different Device ID
   - Different MAC Address
   - Different User-Agent
   - Different Proxy IP

4. ANTI-BAN TIMING
   - 1-7 seconds between messages
   - Short break every 10 messages (30-120 sec)
   - Long break every 50 messages (5-15 min)
   - Max 100 messages per account per day

=============================================================
OUTPUT REQUIREMENTS
=============================================================

Generate ALL files with COMPLETE, WORKING code:

1. All folder structure
2. master-server/package.json (complete)
3. master-server/src/app.js (Express server with all routes)
4. master-server/src/services/LoadBalancer.js (full implementation)
5. master-server/src/services/AntiBanEngine.js (with timing from docs)
6. master-server/src/api/routes/*.js (all route files)
7. worker/go.mod (based on go-whatsapp-base)
8. worker/cmd/worker/main.go (HTTP server + WhatsApp client)
9. worker/internal/fingerprint/generator.go (unique per worker)
10. worker/internal/whatsapp/client.go (wrapper around whatsmeow)
11. docker/docker-compose.yml (all services, 3 workers)
12. database/init.sql (all tables with indexes)
13. All .env.example files
14. All Dockerfiles

Start generating each file one by one. Show complete code for each.
Begin with the folder structure, then package.json, then go.mod.
=============================================================
```

---

## 📋 רשימת קבצים בפרויקט

| תיקייה | קובץ | תיאור |
|--------|------|-------|
| `/` | SYSTEM_SPECIFICATION.md | האיפיון המלא |
| `/` | CURSOR_STAGE_1_COMMAND.md | הפקודה הזו |
| `/docs` | AntiBan_Algorithm*.txt | אלגוריתם Anti-Ban |
| `/docs` | CRITICAL_RULES*.txt | חוקי Proxy |
| `/docs` | PHONE_TOKEN*.txt | קשר טלפון-פרוקסי |
| `/docs` | COMPLETE_WORKFLOW*.txt | תהליך QR |
| `/docs` | FULL_AUTOMATION*.txt | אוטומציה מלאה |
| `/go-whatsapp-base` | (כל הפרויקט) | ספריית Go בסיסית |

---

## ✅ מה לעשות?

1. פתח Cursor
2. צור פרויקט חדש או פתח תיקייה ריקה
3. גרור את כל תוכן ה-ZIP לתוך Cursor
4. העתק את הפקודה למעלה (מ-``` עד ```)
5. שלח ל-Cursor
6. תן לו ליצור את כל הקבצים

---

## 🔜 אחרי שלב 1

כשתסיים, תחזור אליי ואני אתן לך את **שלב 2** - Database & Infrastructure
