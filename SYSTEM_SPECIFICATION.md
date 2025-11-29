# 🚀 WhatsApp Multi-Docker Automation System
## איפיון מערכת מלא - שלב אחר שלב

---

## 📋 תוכן עניינים

1. [סקירת ארכיטקטורה](#1-סקירת-ארכיטקטורה)
2. [רכיבי המערכת](#2-רכיבי-המערכת)
3. [Master Server - שרת מרכזי](#3-master-server---שרת-מרכזי)
4. [Worker Dockers - קונטיינרים עובדים](#4-worker-dockers---קונטיינרים-עובדים)
5. [Dashboard - ממשק ניהול](#5-dashboard---ממשק-ניהול)
6. [Anti-Ban System](#6-anti-ban-system)
7. [Database Schema](#7-database-schema)
8. [API Endpoints](#8-api-endpoints)
9. [Proxy Management](#9-proxy-management)
10. [הוראות הקמה](#10-הוראות-הקמה)

---

## 1. סקירת ארכיטקטורה

```
                            ┌─────────────────────────────────────┐
                            │         DASHBOARD (React)           │
                            │    http://localhost:8080            │
                            │  ┌─────────────────────────────────┐│
                            │  │ 📊 Accounts    │ 📨 Messages   ││
                            │  │ 🔄 Workers     │ 📈 Analytics  ││
                            │  └─────────────────────────────────┘│
                            └────────────────┬────────────────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         MASTER SERVER (Node.js/Go)                          │
│                          http://localhost:5000                              │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                              SERVICES                                 │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────┐ │  │
│  │  │ API Router │ │ Load Bal.  │ │ Anti-Ban   │ │  Account Manager   │ │  │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────────────┘ │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────────┐ │  │
│  │  │ Message Q  │ │ Scheduler  │ │ Health Mon │ │   Proxy Manager    │ │  │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                           DATABASES                                   │  │
│  │    PostgreSQL (Accounts)  │  Redis (Queue/Cache)  │  SQLite (Local)  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
                    ▼                        ▼                        ▼
    ┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐
    │   WORKER DOCKER #1    │  │   WORKER DOCKER #2    │  │   WORKER DOCKER #N    │
    │   Port: 3001          │  │   Port: 3002          │  │   Port: 300N          │
    │   ┌─────────────────┐ │  │   ┌─────────────────┐ │  │   ┌─────────────────┐ │
    │   │ WhatsApp Client │ │  │   │ WhatsApp Client │ │  │   │ WhatsApp Client │ │
    │   │ (go-whatsapp)   │ │  │   │ (go-whatsapp)   │ │  │   │ (go-whatsapp)   │ │
    │   └─────────────────┘ │  │   └─────────────────┘ │  │   └─────────────────┘ │
    │   ┌─────────────────┐ │  │   ┌─────────────────┐ │  │   ┌─────────────────┐ │
    │   │  Accounts: 50   │ │  │   │  Accounts: 50   │ │  │   │  Accounts: 50   │ │
    │   │  Proxy: Group A │ │  │   │  Proxy: Group B │ │  │   │  Proxy: Group N │ │
    │   └─────────────────┘ │  │   └─────────────────┘ │  │   └─────────────────┘ │
    └───────────────────────┘  └───────────────────────┘  └───────────────────────┘
            │                          │                          │
            ▼                          ▼                          ▼
    ┌───────────────┐          ┌───────────────┐          ┌───────────────┐
    │  Proxy Pool   │          │  Proxy Pool   │          │  Proxy Pool   │
    │  (Oxylabs)    │          │  (Oxylabs)    │          │  (Oxylabs)    │
    │  IP: US/IL    │          │  IP: UK/CA    │          │  IP: Mixed    │
    └───────────────┘          └───────────────┘          └───────────────┘
            │                          │                          │
            └──────────────────────────┼──────────────────────────┘
                                       ▼
                              ┌─────────────────┐
                              │  WhatsApp API   │
                              │  (Multi-Device) │
                              └─────────────────┘
```

---

## 2. רכיבי המערכת

### 2.1 רכיבים עיקריים

| רכיב | תפקיד | טכנולוגיה | פורט |
|------|-------|-----------|------|
| **Master Server** | ניהול מרכזי, API Gateway, Load Balancing | Node.js/Go | 5000 |
| **Worker Docker** | הרצת WhatsApp clients, שליחת הודעות | Go + whatsmeow | 3001-300N |
| **Dashboard** | ממשק ניהול למשתמש | React/Vue | 8080 |
| **PostgreSQL** | אחסון חשבונות ומסרים | PostgreSQL 15 | 5432 |
| **Redis** | Queue, Cache, Pub/Sub | Redis 7 | 6379 |
| **Nginx** | Reverse Proxy, SSL | Nginx | 80/443 |

### 2.2 תלויות בין רכיבים

```
Dashboard ──────► Master Server ──────► Workers
    │                  │                   │
    │                  ▼                   │
    │            PostgreSQL ◄──────────────┘
    │                  │
    └─────────────► Redis
```

---

## 3. Master Server - שרת מרכזי

### 3.1 מבנה הפרויקט

```
master-server/
├── src/
│   ├── api/
│   │   ├── routes/
│   │   │   ├── accounts.js       # ניהול חשבונות
│   │   │   ├── messages.js       # שליחת הודעות
│   │   │   ├── workers.js        # ניהול workers
│   │   │   ├── campaigns.js      # קמפיינים
│   │   │   └── health.js         # בדיקת תקינות
│   │   └── middleware/
│   │       ├── auth.js           # אימות
│   │       ├── rateLimit.js      # הגבלת קצב
│   │       └── validator.js      # ולידציה
│   │
│   ├── services/
│   │   ├── LoadBalancer.js       # חלוקת עומס בין workers
│   │   ├── AntiBanEngine.js      # מנוע Anti-Ban
│   │   ├── ProxyManager.js       # ניהול פרוקסים
│   │   ├── MessageQueue.js       # תור הודעות
│   │   ├── WorkerManager.js      # ניהול workers
│   │   ├── AccountManager.js     # ניהול חשבונות
│   │   └── SchedulerService.js   # תזמון משימות
│   │
│   ├── models/
│   │   ├── Account.js            # מודל חשבון
│   │   ├── Worker.js             # מודל worker
│   │   ├── Message.js            # מודל הודעה
│   │   ├── Campaign.js           # מודל קמפיין
│   │   └── Proxy.js              # מודל פרוקסי
│   │
│   ├── utils/
│   │   ├── logger.js             # לוגים
│   │   ├── crypto.js             # הצפנה
│   │   └── validators.js         # ולידציות
│   │
│   ├── config/
│   │   ├── database.js           # הגדרות DB
│   │   ├── redis.js              # הגדרות Redis
│   │   └── workers.js            # הגדרות Workers
│   │
│   └── app.js                    # Entry point
│
├── docker-compose.yml
├── Dockerfile
├── package.json
└── .env
```

### 3.2 קוד ליבה - Load Balancer

```javascript
// src/services/LoadBalancer.js

class LoadBalancer {
    constructor(workerManager) {
        this.workerManager = workerManager;
        this.algorithm = 'round-robin'; // or 'least-connections', 'weighted'
        this.currentIndex = 0;
    }

    /**
     * בחר worker מתאים לשליחת הודעה
     * @param {Object} message - ההודעה לשליחה
     * @param {Object} account - החשבון השולח
     * @returns {Object} worker נבחר
     */
    async selectWorker(message, account) {
        const workers = await this.workerManager.getHealthyWorkers();
        
        if (workers.length === 0) {
            throw new Error('No healthy workers available');
        }

        // 1. סנן workers לפי מדינת הפרוקסי
        const countryWorkers = workers.filter(w => 
            w.proxyCountry === account.country
        );

        // 2. אם אין workers למדינה - השתמש בכל worker
        const availableWorkers = countryWorkers.length > 0 
            ? countryWorkers 
            : workers;

        // 3. בחר לפי אלגוריתם
        let selectedWorker;
        
        switch (this.algorithm) {
            case 'round-robin':
                selectedWorker = this.roundRobin(availableWorkers);
                break;
            case 'least-connections':
                selectedWorker = this.leastConnections(availableWorkers);
                break;
            case 'weighted':
                selectedWorker = this.weighted(availableWorkers);
                break;
            default:
                selectedWorker = availableWorkers[0];
        }

        return selectedWorker;
    }

    roundRobin(workers) {
        const worker = workers[this.currentIndex % workers.length];
        this.currentIndex++;
        return worker;
    }

    leastConnections(workers) {
        return workers.reduce((min, worker) => 
            worker.activeConnections < min.activeConnections ? worker : min
        );
    }

    weighted(workers) {
        // בחר לפי משקל (accounts בריאים)
        const totalWeight = workers.reduce((sum, w) => sum + w.healthyAccounts, 0);
        let random = Math.random() * totalWeight;
        
        for (const worker of workers) {
            random -= worker.healthyAccounts;
            if (random <= 0) return worker;
        }
        
        return workers[0];
    }

    /**
     * הפץ הודעות לכל ה-workers
     * @param {Array} messages - רשימת הודעות
     * @returns {Object} תוצאות ההפצה
     */
    async distributeMessages(messages) {
        const distribution = {};
        
        for (const message of messages) {
            const account = await this.getAccountForMessage(message);
            const worker = await this.selectWorker(message, account);
            
            if (!distribution[worker.id]) {
                distribution[worker.id] = [];
            }
            
            distribution[worker.id].push({
                message,
                account,
                priority: message.priority || 'normal'
            });
        }

        // שלח לכל worker את החבילה שלו
        const results = await Promise.all(
            Object.entries(distribution).map(([workerId, batch]) => 
                this.sendBatchToWorker(workerId, batch)
            )
        );

        return {
            distributed: messages.length,
            workers: Object.keys(distribution).length,
            results
        };
    }
}

module.exports = LoadBalancer;
```

### 3.3 Message Queue Service

```javascript
// src/services/MessageQueue.js

const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

class MessageQueue {
    constructor() {
        this.redis = new Redis(process.env.REDIS_URL);
        this.pubsub = new Redis(process.env.REDIS_URL);
        this.queues = {
            HIGH: 'queue:messages:high',
            NORMAL: 'queue:messages:normal',
            LOW: 'queue:messages:low'
        };
    }

    /**
     * הוסף הודעה לתור
     */
    async enqueue(message) {
        const messageId = uuidv4();
        const queueKey = this.queues[message.priority] || this.queues.NORMAL;
        
        const queueMessage = {
            id: messageId,
            ...message,
            status: 'pending',
            createdAt: new Date().toISOString(),
            attempts: 0,
            maxAttempts: 3
        };

        // שמור בRedis כ-JSON
        await this.redis.hset(
            'messages:pending', 
            messageId, 
            JSON.stringify(queueMessage)
        );

        // הוסף לתור לפי עדיפות
        await this.redis.lpush(queueKey, messageId);

        // פרסם event חדש
        await this.pubsub.publish('new-message', JSON.stringify({
            id: messageId,
            priority: message.priority
        }));

        return messageId;
    }

    /**
     * קבל הודעה הבאה מהתור
     */
    async dequeue() {
        // בדוק תורים לפי סדר עדיפות
        for (const priority of ['HIGH', 'NORMAL', 'LOW']) {
            const messageId = await this.redis.rpop(this.queues[priority]);
            
            if (messageId) {
                const messageJson = await this.redis.hget('messages:pending', messageId);
                if (messageJson) {
                    const message = JSON.parse(messageJson);
                    message.status = 'processing';
                    message.startedAt = new Date().toISOString();
                    
                    // עדכן סטטוס
                    await this.redis.hset(
                        'messages:pending', 
                        messageId, 
                        JSON.stringify(message)
                    );
                    
                    return message;
                }
            }
        }
        
        return null;
    }

    /**
     * סמן הודעה כנשלחה
     */
    async markCompleted(messageId, result) {
        const messageJson = await this.redis.hget('messages:pending', messageId);
        if (!messageJson) return;

        const message = JSON.parse(messageJson);
        message.status = 'completed';
        message.completedAt = new Date().toISOString();
        message.result = result;

        // העבר לארכיון
        await this.redis.hset('messages:completed', messageId, JSON.stringify(message));
        await this.redis.hdel('messages:pending', messageId);

        // עדכן סטטיסטיקות
        await this.updateStats('completed');
    }

    /**
     * טפל בהודעה שנכשלה
     */
    async handleFailure(messageId, error) {
        const messageJson = await this.redis.hget('messages:pending', messageId);
        if (!messageJson) return;

        const message = JSON.parse(messageJson);
        message.attempts++;
        message.lastError = error.message;

        if (message.attempts >= message.maxAttempts) {
            // העבר ל-Dead Letter Queue
            message.status = 'failed';
            await this.redis.hset('messages:failed', messageId, JSON.stringify(message));
            await this.redis.hdel('messages:pending', messageId);
        } else {
            // החזר לתור עם backoff
            const backoffMs = Math.pow(2, message.attempts) * 1000;
            message.nextRetry = new Date(Date.now() + backoffMs).toISOString();
            
            await this.redis.hset('messages:pending', messageId, JSON.stringify(message));
            
            // הוסף שוב לתור אחרי delay
            setTimeout(async () => {
                await this.redis.lpush(this.queues.LOW, messageId);
            }, backoffMs);
        }
    }

    /**
     * קבל סטטיסטיקות התור
     */
    async getStats() {
        const [high, normal, low, pending, completed, failed] = await Promise.all([
            this.redis.llen(this.queues.HIGH),
            this.redis.llen(this.queues.NORMAL),
            this.redis.llen(this.queues.LOW),
            this.redis.hlen('messages:pending'),
            this.redis.hlen('messages:completed'),
            this.redis.hlen('messages:failed')
        ]);

        return {
            queued: { high, normal, low, total: high + normal + low },
            pending,
            completed,
            failed
        };
    }
}

module.exports = MessageQueue;
```

---

## 4. Worker Dockers - קונטיינרים עובדים

### 4.1 Worker Dockerfile

```dockerfile
# worker/Dockerfile

############################
# STEP 1: Build Go binary
############################
FROM golang:1.22-alpine AS builder

RUN apk update && apk add --no-cache gcc musl-dev gcompat git

WORKDIR /app

# Copy go mod files first for caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build with optimizations
RUN CGO_ENABLED=1 go build -a -ldflags="-w -s" -o /worker ./cmd/worker

############################
# STEP 2: Production image
############################
FROM alpine:3.20

RUN apk add --no-cache ffmpeg tzdata ca-certificates

# Create non-root user
RUN adduser -D -g '' appuser

WORKDIR /app

# Copy binary
COPY --from=builder /worker /app/worker

# Create directories
RUN mkdir -p /app/sessions /app/logs /app/media && \
    chown -R appuser:appuser /app

USER appuser

# Environment variables
ENV WORKER_ID=""
ENV MASTER_URL=""
ENV WORKER_PORT=3000
ENV MAX_ACCOUNTS=50
ENV LOG_LEVEL=info

EXPOSE ${WORKER_PORT}

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${WORKER_PORT}/health || exit 1

ENTRYPOINT ["/app/worker"]
```

### 4.2 Worker Main Code

```go
// worker/cmd/worker/main.go

package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "github.com/gorilla/mux"
    "go.mau.fi/whatsmeow"
    "go.mau.fi/whatsmeow/store/sqlstore"
)

type Worker struct {
    ID            string
    Port          string
    MasterURL     string
    MaxAccounts   int
    
    clients       map[string]*whatsmeow.Client // phone -> client
    clientsMutex  sync.RWMutex
    
    proxyPool     *ProxyPool
    antiBan       *AntiBanEngine
    
    isHealthy     bool
    lastHeartbeat time.Time
}

func main() {
    worker := &Worker{
        ID:          getEnv("WORKER_ID", "worker-1"),
        Port:        getEnv("WORKER_PORT", "3000"),
        MasterURL:   getEnv("MASTER_URL", "http://master:5000"),
        MaxAccounts: getEnvInt("MAX_ACCOUNTS", 50),
        clients:     make(map[string]*whatsmeow.Client),
        isHealthy:   true,
    }

    // Initialize components
    worker.proxyPool = NewProxyPool()
    worker.antiBan = NewAntiBanEngine()

    // Setup HTTP routes
    router := mux.NewRouter()
    
    // Health & Status
    router.HandleFunc("/health", worker.handleHealth).Methods("GET")
    router.HandleFunc("/status", worker.handleStatus).Methods("GET")
    
    // Account Management
    router.HandleFunc("/accounts", worker.handleListAccounts).Methods("GET")
    router.HandleFunc("/accounts/connect", worker.handleConnect).Methods("POST")
    router.HandleFunc("/accounts/disconnect", worker.handleDisconnect).Methods("POST")
    router.HandleFunc("/accounts/{phone}/qr", worker.handleGetQR).Methods("GET")
    
    // Messaging
    router.HandleFunc("/send", worker.handleSendMessage).Methods("POST")
    router.HandleFunc("/send/bulk", worker.handleSendBulk).Methods("POST")
    
    // Start heartbeat to master
    go worker.heartbeatLoop()
    
    // Start HTTP server
    server := &http.Server{
        Addr:         ":" + worker.Port,
        Handler:      router,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
    }

    // Graceful shutdown
    go func() {
        sigChan := make(chan os.Signal, 1)
        signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
        <-sigChan
        
        log.Println("Shutting down worker...")
        worker.disconnectAll()
        server.Shutdown(context.Background())
    }()

    log.Printf("Worker %s starting on port %s", worker.ID, worker.Port)
    if err := server.ListenAndServe(); err != http.ErrServerClosed {
        log.Fatalf("Server error: %v", err)
    }
}

// Connect a WhatsApp account
func (w *Worker) handleConnect(rw http.ResponseWriter, r *http.Request) {
    var req struct {
        Phone         string `json:"phone"`
        SessionToken  string `json:"session_token,omitempty"`
        ProxyIP       string `json:"proxy_ip"`
        ProxyPort     int    `json:"proxy_port"`
        ProxyUsername string `json:"proxy_username"`
        ProxyPassword string `json:"proxy_password"`
        Country       string `json:"country"`
    }

    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(rw, err.Error(), http.StatusBadRequest)
        return
    }

    // Check capacity
    w.clientsMutex.RLock()
    if len(w.clients) >= w.MaxAccounts {
        w.clientsMutex.RUnlock()
        http.Error(rw, "Worker at capacity", http.StatusServiceUnavailable)
        return
    }
    w.clientsMutex.RUnlock()

    // Configure proxy
    proxy := &Proxy{
        IP:       req.ProxyIP,
        Port:     req.ProxyPort,
        Username: req.ProxyUsername,
        Password: req.ProxyPassword,
        Country:  req.Country,
    }

    // Create WhatsApp client with proxy
    client, err := w.createClient(req.Phone, proxy, req.SessionToken)
    if err != nil {
        http.Error(rw, err.Error(), http.StatusInternalServerError)
        return
    }

    w.clientsMutex.Lock()
    w.clients[req.Phone] = client
    w.clientsMutex.Unlock()

    json.NewEncoder(rw).Encode(map[string]interface{}{
        "success": true,
        "phone":   req.Phone,
        "status":  "connected",
    })
}

// Send a single message with Anti-Ban
func (w *Worker) handleSendMessage(rw http.ResponseWriter, r *http.Request) {
    var req struct {
        FromPhone string `json:"from_phone"`
        ToPhone   string `json:"to_phone"`
        Message   string `json:"message"`
        MediaURL  string `json:"media_url,omitempty"`
    }

    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(rw, err.Error(), http.StatusBadRequest)
        return
    }

    // Get client
    w.clientsMutex.RLock()
    client, exists := w.clients[req.FromPhone]
    w.clientsMutex.RUnlock()

    if !exists {
        http.Error(rw, "Account not connected", http.StatusNotFound)
        return
    }

    // Apply Anti-Ban timing
    delay := w.antiBan.GetDelay(req.FromPhone)
    time.Sleep(delay)

    // Apply message variation
    message := w.antiBan.VariateMessage(req.Message)

    // Send message
    result, err := w.sendMessage(client, req.ToPhone, message, req.MediaURL)
    if err != nil {
        w.antiBan.RecordFailure(req.FromPhone)
        http.Error(rw, err.Error(), http.StatusInternalServerError)
        return
    }

    w.antiBan.RecordSuccess(req.FromPhone)

    json.NewEncoder(rw).Encode(map[string]interface{}{
        "success":    true,
        "message_id": result.ID,
        "from":       req.FromPhone,
        "to":         req.ToPhone,
    })
}

// Heartbeat to master server
func (w *Worker) heartbeatLoop() {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        w.sendHeartbeat()
    }
}

func (w *Worker) sendHeartbeat() {
    w.clientsMutex.RLock()
    accountCount := len(w.clients)
    healthyCount := 0
    for _, client := range w.clients {
        if client.IsConnected() {
            healthyCount++
        }
    }
    w.clientsMutex.RUnlock()

    payload := map[string]interface{}{
        "worker_id":        w.ID,
        "port":             w.Port,
        "healthy":          w.isHealthy,
        "total_accounts":   accountCount,
        "healthy_accounts": healthyCount,
        "max_accounts":     w.MaxAccounts,
        "timestamp":        time.Now().Unix(),
    }

    // Send to master
    // ... HTTP POST to MasterURL/workers/heartbeat
}
```

### 4.3 Docker Compose for Multiple Workers

```yaml
# docker-compose.workers.yml

version: '3.8'

services:
  # ============================================
  # INFRASTRUCTURE
  # ============================================
  
  postgres:
    image: postgres:15-alpine
    container_name: wa_postgres
    environment:
      POSTGRES_USER: whatsapp
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: whatsapp_automation
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U whatsapp"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: wa_redis
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ============================================
  # MASTER SERVER
  # ============================================
  
  master:
    build:
      context: ./master-server
      dockerfile: Dockerfile
    container_name: wa_master
    environment:
      NODE_ENV: production
      PORT: 5000
      DATABASE_URL: postgres://whatsapp:${DB_PASSWORD}@postgres:5432/whatsapp_automation
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      ADMIN_API_KEY: ${ADMIN_API_KEY}
    ports:
      - "5000:5000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # ============================================
  # WORKERS (כל אחד שונה!)
  # ============================================
  
  # Worker 1 - USA Accounts
  worker-1:
    build:
      context: ./worker
      dockerfile: Dockerfile
    container_name: wa_worker_1
    environment:
      WORKER_ID: worker-1
      WORKER_PORT: 3000
      MASTER_URL: http://master:5000
      MAX_ACCOUNTS: 50
      PROXY_COUNTRY: US
      LOG_LEVEL: info
    volumes:
      - worker1_sessions:/app/sessions
      - worker1_logs:/app/logs
    ports:
      - "3001:3000"
    depends_on:
      - master
    restart: on-failure

  # Worker 2 - Israel Accounts
  worker-2:
    build:
      context: ./worker
      dockerfile: Dockerfile
    container_name: wa_worker_2
    environment:
      WORKER_ID: worker-2
      WORKER_PORT: 3000
      MASTER_URL: http://master:5000
      MAX_ACCOUNTS: 50
      PROXY_COUNTRY: IL
      LOG_LEVEL: info
    volumes:
      - worker2_sessions:/app/sessions
      - worker2_logs:/app/logs
    ports:
      - "3002:3000"
    depends_on:
      - master
    restart: on-failure

  # Worker 3 - UK Accounts
  worker-3:
    build:
      context: ./worker
      dockerfile: Dockerfile
    container_name: wa_worker_3
    environment:
      WORKER_ID: worker-3
      WORKER_PORT: 3000
      MASTER_URL: http://master:5000
      MAX_ACCOUNTS: 50
      PROXY_COUNTRY: GB
      LOG_LEVEL: info
    volumes:
      - worker3_sessions:/app/sessions
      - worker3_logs:/app/logs
    ports:
      - "3003:3000"
    depends_on:
      - master
    restart: on-failure

  # Worker 4-10 (להוסיף לפי הצורך)
  # ...

  # ============================================
  # DASHBOARD
  # ============================================
  
  dashboard:
    build:
      context: ./dashboard
      dockerfile: Dockerfile
    container_name: wa_dashboard
    environment:
      REACT_APP_API_URL: http://localhost:5000
    ports:
      - "8080:80"
    depends_on:
      - master

  # ============================================
  # NGINX (Optional - for production)
  # ============================================
  
  nginx:
    image: nginx:alpine
    container_name: wa_nginx
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - master
      - dashboard

volumes:
  postgres_data:
  redis_data:
  worker1_sessions:
  worker1_logs:
  worker2_sessions:
  worker2_logs:
  worker3_sessions:
  worker3_logs:
```

---

## 5. Dashboard - ממשק ניהול

### 5.1 מסכים עיקריים

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WhatsApp Automation Dashboard                    👤 Admin  ⚙️ Settings │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  📊 Overview                                                             │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
│  │ Accounts     │ │ Workers      │ │ Messages/Day │ │ Success Rate │   │
│  │    1,247     │ │    10/10     │ │   45,892     │ │   97.3%      │   │
│  │ +23 today    │ │ All Healthy  │ │ ↑12% vs yday │ │ ↑0.5%        │   │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘   │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  📱 Accounts by Country              🔄 Workers Status                  │
│  ┌─────────────────────────────┐    ┌────────────────────────────────┐ │
│  │ 🇺🇸 USA      │████████│ 523 │    │ Worker-1 │ ✅ │ 47/50 │ US    │ │
│  │ 🇮🇱 Israel   │██████  │ 312 │    │ Worker-2 │ ✅ │ 48/50 │ IL    │ │
│  │ 🇬🇧 UK       │████    │ 198 │    │ Worker-3 │ ✅ │ 45/50 │ GB    │ │
│  │ 🇨🇦 Canada   │███     │ 134 │    │ Worker-4 │ ⚠️ │ 32/50 │ CA    │ │
│  │ 🇩🇪 Germany  │██      │  80 │    │ Worker-5 │ ✅ │ 50/50 │ FR    │ │
│  └─────────────────────────────┘    └────────────────────────────────┘ │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  📨 Recent Messages                                                      │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Time     │ From          │ To            │ Status │ Worker       │   │
│  ├──────────────────────────────────────────────────────────────────┤   │
│  │ 14:32:01 │ +1-555-0123   │ +972-50-123   │ ✅ Sent│ Worker-1     │   │
│  │ 14:32:00 │ +972-50-9999  │ +1-555-7777   │ ✅ Sent│ Worker-2     │   │
│  │ 14:31:58 │ +44-20-1234   │ +49-30-5555   │ ⏳ Pend│ Worker-3     │   │
│  │ 14:31:55 │ +1-555-0456   │ +972-54-888   │ ❌ Fail│ Worker-1     │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  🚀 Quick Actions                                                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ ➕ Add      │ │ 📤 Send     │ │ 🔄 Restart  │ │ 📊 Export   │       │
│  │ Accounts    │ │ Campaign    │ │ Workers     │ │ Report      │       │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Account Management Screen

```
┌─────────────────────────────────────────────────────────────────────────┐
│  📱 Account Management                              🔍 Search  ➕ Add   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Filters: [All ▼] [Status ▼] [Country ▼] [Worker ▼]   Sort: [Date ▼]   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ ☐ │ Phone         │ Country │ Status │ Worker   │ Msgs  │ Score │   │
│  ├──────────────────────────────────────────────────────────────────┤   │
│  │ ☐ │ +1-555-0123   │ 🇺🇸 US   │ ✅ OK   │ Worker-1 │ 1,234 │ 92/100│   │
│  │ ☐ │ +1-555-0124   │ 🇺🇸 US   │ ✅ OK   │ Worker-1 │ 987   │ 88/100│   │
│  │ ☐ │ +972-50-1234  │ 🇮🇱 IL   │ ⚠️ Warn │ Worker-2 │ 756   │ 65/100│   │
│  │ ☐ │ +44-20-5555   │ 🇬🇧 GB   │ ❌ Ban  │ Worker-3 │ 432   │ 0/100 │   │
│  │ ☐ │ +1-555-0125   │ 🇺🇸 US   │ ✅ OK   │ Worker-1 │ 2,100 │ 95/100│   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Selected: 0  │  Bulk Actions: [Move to Worker ▼] [Delete] [Export]     │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  Account Details (click to expand)                                       │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │ Phone: +1-555-0123                                                │   │
│  │ ────────────────────────────────────────────────────────────────  │   │
│  │ Status:     ✅ Connected                                          │   │
│  │ Worker:     Worker-1 (Port 3001)                                  │   │
│  │ Country:    USA                                                   │   │
│  │ Proxy:      195.154.45.123:8080                                   │   │
│  │ Created:    2024-11-20 14:30:22                                   │   │
│  │ Last Active: 2 minutes ago                                        │   │
│  │ Messages:   1,234 sent / 12 failed                                │   │
│  │ Trust Score: 92/100 ████████████████░░░░                          │   │
│  │                                                                    │   │
│  │ [📤 Send Test] [🔄 Reconnect] [⚙️ Edit Proxy] [🗑️ Delete]          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Anti-Ban System

### 6.1 Anti-Ban Engine Implementation

```javascript
// src/services/AntiBanEngine.js

class AntiBanEngine {
    constructor() {
        this.accountStats = new Map();
        this.synonyms = this.loadSynonyms();
        this.config = {
            // Timing Configuration
            baseDelayMin: 1000,       // 1 second minimum
            baseDelayMax: 7000,       // 7 seconds maximum
            jitterRange: 500,         // ±500ms jitter
            
            // Break intervals
            shortBreakEvery: 10,      // Every 10 messages
            shortBreakMin: 30000,     // 30 seconds
            shortBreakMax: 120000,    // 2 minutes
            
            longBreakEvery: 50,       // Every 50 messages
            longBreakMin: 300000,     // 5 minutes
            longBreakMax: 900000,     // 15 minutes
            
            // Limits
            maxDailyPerAccount: 100,  // Max 100 messages per account per day
            maxHourlyPerAccount: 20,  // Max 20 messages per hour
            
            // Trust Score thresholds
            pauseThreshold: 70,       // Pause if score < 70
            slowDownThreshold: 80,    // Slow down if score < 80
        };
    }

    /**
     * Calculate delay before sending next message
     */
    getDelay(phoneNumber) {
        const stats = this.getOrCreateStats(phoneNumber);
        const baseDelay = this.randomRange(
            this.config.baseDelayMin,
            this.config.baseDelayMax
        );
        const jitter = this.randomRange(
            -this.config.jitterRange,
            this.config.jitterRange
        );

        let delay = baseDelay + jitter;

        // Short break every N messages
        if (stats.todayCount % this.config.shortBreakEvery === 0) {
            delay += this.randomRange(
                this.config.shortBreakMin,
                this.config.shortBreakMax
            );
        }

        // Long break every N messages
        if (stats.todayCount % this.config.longBreakEvery === 0) {
            delay += this.randomRange(
                this.config.longBreakMin,
                this.config.longBreakMax
            );
        }

        // Slow down if trust score is low
        if (stats.trustScore < this.config.slowDownThreshold) {
            delay *= 1.5;
        }

        return delay;
    }

    /**
     * Apply message variation (anti-pattern)
     */
    variateMessage(originalMessage) {
        let message = originalMessage;

        // 1. Apply spin syntax: {Hello|Hi|Hey}
        message = this.applySpinSyntax(message);

        // 2. Replace synonyms
        message = this.applySynonyms(message);

        // 3. Add random whitespace variations
        message = this.addWhitespaceVariations(message);

        // 4. Vary punctuation
        message = this.varyPunctuation(message);

        return message;
    }

    applySpinSyntax(text) {
        // Match {option1|option2|option3}
        const spinRegex = /\{([^{}]+)\}/g;
        return text.replace(spinRegex, (match, group) => {
            const options = group.split('|');
            return options[Math.floor(Math.random() * options.length)];
        });
    }

    applySynonyms(text) {
        let result = text;
        for (const [word, synonymList] of Object.entries(this.synonyms)) {
            if (result.toLowerCase().includes(word.toLowerCase())) {
                if (Math.random() < 0.3) { // 30% chance to replace
                    const synonym = synonymList[
                        Math.floor(Math.random() * synonymList.length)
                    ];
                    result = result.replace(
                        new RegExp(word, 'i'),
                        synonym
                    );
                }
            }
        }
        return result;
    }

    addWhitespaceVariations(text) {
        // Randomly add extra spaces or newlines
        if (Math.random() < 0.1) {
            text = text + ' ';
        }
        if (Math.random() < 0.05) {
            text = ' ' + text;
        }
        return text;
    }

    varyPunctuation(text) {
        // Vary exclamation marks
        if (Math.random() < 0.2) {
            text = text.replace(/!$/, '!!');
        }
        // Add/remove periods
        if (Math.random() < 0.1 && !text.endsWith('.')) {
            text = text + '.';
        }
        return text;
    }

    /**
     * Check if account can send (within limits)
     */
    canSend(phoneNumber) {
        const stats = this.getOrCreateStats(phoneNumber);

        // Check daily limit
        if (stats.todayCount >= this.config.maxDailyPerAccount) {
            return { allowed: false, reason: 'Daily limit reached' };
        }

        // Check hourly limit
        if (stats.hourCount >= this.config.maxHourlyPerAccount) {
            return { allowed: false, reason: 'Hourly limit reached' };
        }

        // Check trust score
        if (stats.trustScore < this.config.pauseThreshold) {
            return { allowed: false, reason: 'Trust score too low' };
        }

        return { allowed: true };
    }

    /**
     * Record successful send
     */
    recordSuccess(phoneNumber) {
        const stats = this.getOrCreateStats(phoneNumber);
        stats.todayCount++;
        stats.hourCount++;
        stats.totalSent++;
        stats.lastSentAt = Date.now();
        
        // Increase trust score (max 100)
        stats.trustScore = Math.min(100, stats.trustScore + 0.5);
    }

    /**
     * Record failed send
     */
    recordFailure(phoneNumber, error) {
        const stats = this.getOrCreateStats(phoneNumber);
        stats.failureCount++;
        stats.lastError = error;
        
        // Decrease trust score
        stats.trustScore = Math.max(0, stats.trustScore - 5);

        // Check for ban indicators
        if (this.isBanIndicator(error)) {
            stats.trustScore = 0;
            stats.status = 'banned';
        }
    }

    isBanIndicator(error) {
        const banKeywords = [
            'banned',
            'blocked',
            'restricted',
            'unusual activity',
            'temporarily unavailable',
            'account suspended'
        ];
        const errorLower = error.toLowerCase();
        return banKeywords.some(keyword => errorLower.includes(keyword));
    }

    getOrCreateStats(phoneNumber) {
        if (!this.accountStats.has(phoneNumber)) {
            this.accountStats.set(phoneNumber, {
                todayCount: 0,
                hourCount: 0,
                totalSent: 0,
                failureCount: 0,
                trustScore: 60, // Starting score
                lastSentAt: null,
                lastError: null,
                status: 'active'
            });
        }
        return this.accountStats.get(phoneNumber);
    }

    randomRange(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    loadSynonyms() {
        return {
            'hello': ['hi', 'hey', 'greetings', 'howdy'],
            'great': ['awesome', 'amazing', 'wonderful', 'excellent'],
            'check': ['look at', 'see', 'view', 'take a look at'],
            'out': [''],
            // ... more synonyms
        };
    }

    /**
     * Reset hourly counts (call every hour)
     */
    resetHourlyCounts() {
        for (const stats of this.accountStats.values()) {
            stats.hourCount = 0;
        }
    }

    /**
     * Reset daily counts (call at midnight)
     */
    resetDailyCounts() {
        for (const stats of this.accountStats.values()) {
            stats.todayCount = 0;
        }
    }
}

module.exports = AntiBanEngine;
```

### 6.2 Anti-Ban Configuration Table

| Parameter | Value | Description |
|-----------|-------|-------------|
| Base Delay | 1-7 sec | Random delay between messages |
| Jitter | ±500ms | Randomness added to delays |
| Short Break | Every 10 msgs | 30-120 sec pause |
| Long Break | Every 50 msgs | 5-15 min pause |
| Session Break | Every 100 msgs | 15-30 min pause + fingerprint rotation |
| Daily Limit | 100/account | Maximum messages per day per account |
| Hourly Limit | 20/account | Maximum messages per hour per account |
| Trust Score Min | 70 | Below this - pause account |
| Proxy Rotation | Every 10-20 msgs | Change proxy IP |
| Fingerprint Rotation | Every 50 msgs | Change device fingerprint |

---

## 7. Database Schema

### 7.1 PostgreSQL Tables

```sql
-- init.sql

-- Workers table
CREATE TABLE workers (
    id VARCHAR(50) PRIMARY KEY,
    port INTEGER NOT NULL,
    host VARCHAR(255) DEFAULT 'localhost',
    proxy_country VARCHAR(10),
    max_accounts INTEGER DEFAULT 50,
    status VARCHAR(20) DEFAULT 'active',
    last_heartbeat TIMESTAMP,
    healthy_accounts INTEGER DEFAULT 0,
    total_accounts INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Accounts table
CREATE TABLE accounts (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    session_token TEXT,
    country VARCHAR(10) NOT NULL,
    
    -- Proxy information
    proxy_ip VARCHAR(50),
    proxy_port INTEGER,
    proxy_username VARCHAR(100),
    proxy_password VARCHAR(100),
    proxy_provider VARCHAR(50),
    
    -- Worker assignment
    worker_id VARCHAR(50) REFERENCES workers(id),
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending', -- pending, connected, disconnected, banned
    trust_score INTEGER DEFAULT 60,
    
    -- Statistics
    messages_sent INTEGER DEFAULT 0,
    messages_failed INTEGER DEFAULT 0,
    last_message_at TIMESTAMP,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    verified_at TIMESTAMP,
    banned_at TIMESTAMP,
    
    -- Indexes
    CONSTRAINT valid_status CHECK (status IN ('pending', 'connecting', 'connected', 'disconnected', 'banned', 'warming'))
);

CREATE INDEX idx_accounts_worker ON accounts(worker_id);
CREATE INDEX idx_accounts_country ON accounts(country);
CREATE INDEX idx_accounts_status ON accounts(status);

-- Messages table
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Sender & Recipient
    from_account_id INTEGER REFERENCES accounts(id),
    from_phone VARCHAR(20) NOT NULL,
    to_phone VARCHAR(20) NOT NULL,
    
    -- Content
    message_text TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text', -- text, image, video, audio, document
    media_url TEXT,
    
    -- Campaign reference
    campaign_id INTEGER,
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending', -- pending, queued, sending, sent, failed
    priority VARCHAR(10) DEFAULT 'normal', -- high, normal, low
    
    -- Delivery info
    worker_id VARCHAR(50),
    sent_at TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_messages_status ON messages(status);
CREATE INDEX idx_messages_from ON messages(from_phone);
CREATE INDEX idx_messages_campaign ON messages(campaign_id);
CREATE INDEX idx_messages_created ON messages(created_at);

-- Campaigns table
CREATE TABLE campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- Message template
    message_template TEXT NOT NULL,
    message_type VARCHAR(20) DEFAULT 'text',
    media_url TEXT,
    
    -- Targeting
    target_phones TEXT[], -- Array of phone numbers
    target_count INTEGER DEFAULT 0,
    
    -- Scheduling
    status VARCHAR(20) DEFAULT 'draft', -- draft, scheduled, running, paused, completed
    scheduled_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    
    -- Statistics
    messages_sent INTEGER DEFAULT 0,
    messages_failed INTEGER DEFAULT 0,
    messages_delivered INTEGER DEFAULT 0,
    
    -- Configuration
    accounts_to_use INTEGER[], -- Array of account IDs
    priority VARCHAR(10) DEFAULT 'normal',
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Proxies table
CREATE TABLE proxies (
    id SERIAL PRIMARY KEY,
    ip VARCHAR(50) NOT NULL,
    port INTEGER NOT NULL,
    username VARCHAR(100),
    password VARCHAR(100),
    country VARCHAR(10) NOT NULL,
    provider VARCHAR(50),
    type VARCHAR(20) DEFAULT 'residential', -- residential, datacenter, mobile
    
    -- Status
    status VARCHAR(20) DEFAULT 'active', -- active, inactive, failed
    last_tested_at TIMESTAMP,
    response_time_ms INTEGER,
    
    -- Usage
    assigned_account_id INTEGER REFERENCES accounts(id),
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(ip, port)
);

CREATE INDEX idx_proxies_country ON proxies(country);
CREATE INDEX idx_proxies_status ON proxies(status);

-- System logs table
CREATE TABLE system_logs (
    id SERIAL PRIMARY KEY,
    level VARCHAR(10) NOT NULL, -- debug, info, warn, error
    source VARCHAR(50) NOT NULL, -- master, worker-1, etc.
    message TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_logs_created ON system_logs(created_at);
CREATE INDEX idx_logs_level ON system_logs(level);
```

---

## 8. API Endpoints

### 8.1 Master Server API

| Method | Endpoint | Description |
|--------|----------|-------------|
| **Accounts** | | |
| GET | `/api/accounts` | List all accounts |
| POST | `/api/accounts` | Create new account |
| GET | `/api/accounts/:phone` | Get account details |
| PUT | `/api/accounts/:phone` | Update account |
| DELETE | `/api/accounts/:phone` | Delete account |
| POST | `/api/accounts/:phone/connect` | Connect account to WhatsApp |
| POST | `/api/accounts/:phone/disconnect` | Disconnect account |
| GET | `/api/accounts/:phone/qr` | Get QR code for account |
| **Messages** | | |
| POST | `/api/messages/send` | Send single message |
| POST | `/api/messages/bulk` | Send bulk messages |
| GET | `/api/messages/:id` | Get message status |
| GET | `/api/messages` | List messages (with filters) |
| **Workers** | | |
| GET | `/api/workers` | List all workers |
| GET | `/api/workers/:id` | Get worker details |
| POST | `/api/workers/:id/restart` | Restart worker |
| **Campaigns** | | |
| GET | `/api/campaigns` | List campaigns |
| POST | `/api/campaigns` | Create campaign |
| PUT | `/api/campaigns/:id` | Update campaign |
| POST | `/api/campaigns/:id/start` | Start campaign |
| POST | `/api/campaigns/:id/pause` | Pause campaign |
| **Dashboard** | | |
| GET | `/api/dashboard/stats` | Get overview stats |
| GET | `/api/dashboard/charts` | Get chart data |
| **Health** | | |
| GET | `/health` | Health check |
| GET | `/api/system/status` | System status |

### 8.2 Worker API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Worker health check |
| GET | `/status` | Worker status & stats |
| GET | `/accounts` | List connected accounts |
| POST | `/accounts/connect` | Connect account |
| POST | `/accounts/disconnect` | Disconnect account |
| GET | `/accounts/:phone/qr` | Get QR code |
| POST | `/send` | Send message |
| POST | `/send/bulk` | Send bulk messages |

---

## 9. Proxy Management

### 9.1 Proxy Configuration

```javascript
// src/services/ProxyManager.js

class ProxyManager {
    constructor(db) {
        this.db = db;
        this.providers = {
            oxylabs: {
                format: (country) => ({
                    host: 'pr.oxylabs.io',
                    port: 7777,
                    username: `customer-${process.env.OXYLABS_USER}-cc-${country}`,
                    password: process.env.OXYLABS_PASS
                })
            },
            brightdata: {
                format: (country) => ({
                    host: `brd.superproxy.io`,
                    port: 22225,
                    username: `${process.env.BRIGHTDATA_USER}-country-${country}`,
                    password: process.env.BRIGHTDATA_PASS
                })
            }
        };
    }

    /**
     * Get proxy for specific country
     */
    async getProxyForCountry(country) {
        // First try to get from pool
        const existing = await this.db.query(
            `SELECT * FROM proxies 
             WHERE country = $1 AND status = 'active' 
             AND assigned_account_id IS NULL
             ORDER BY last_tested_at ASC NULLS FIRST
             LIMIT 1`,
            [country]
        );

        if (existing.rows.length > 0) {
            return existing.rows[0];
        }

        // Generate new proxy from provider
        const provider = this.providers[process.env.PROXY_PROVIDER];
        return provider.format(country.toLowerCase());
    }

    /**
     * Assign proxy to account
     */
    async assignProxyToAccount(proxyId, accountId) {
        await this.db.query(
            `UPDATE proxies SET assigned_account_id = $1 WHERE id = $2`,
            [accountId, proxyId]
        );
    }

    /**
     * Test proxy connectivity
     */
    async testProxy(proxy) {
        const start = Date.now();
        try {
            const response = await fetch('https://api.ipify.org?format=json', {
                agent: new HttpsProxyAgent(
                    `http://${proxy.username}:${proxy.password}@${proxy.ip}:${proxy.port}`
                ),
                timeout: 10000
            });
            const data = await response.json();
            const responseTime = Date.now() - start;

            return {
                success: true,
                ip: data.ip,
                responseTime
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Rotate proxy for account
     */
    async rotateProxy(accountId) {
        const account = await this.db.query(
            `SELECT * FROM accounts WHERE id = $1`,
            [accountId]
        );

        if (!account.rows.length) return null;

        // Release old proxy
        await this.db.query(
            `UPDATE proxies SET assigned_account_id = NULL 
             WHERE assigned_account_id = $1`,
            [accountId]
        );

        // Get new proxy
        const newProxy = await this.getProxyForCountry(account.rows[0].country);
        
        // Update account
        await this.db.query(
            `UPDATE accounts SET 
             proxy_ip = $1, proxy_port = $2, 
             proxy_username = $3, proxy_password = $4
             WHERE id = $5`,
            [newProxy.host, newProxy.port, newProxy.username, newProxy.password, accountId]
        );

        return newProxy;
    }
}

module.exports = ProxyManager;
```

---

## 10. הוראות הקמה

### 10.1 Prerequisites

```bash
# Required software
- Docker >= 24.0
- Docker Compose >= 2.20
- Node.js >= 20 (for development)
- Go >= 1.22 (for development)
- Git
```

### 10.2 Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-repo/whatsapp-automation.git
cd whatsapp-automation

# 2. Copy environment files
cp .env.example .env
cp master-server/.env.example master-server/.env
cp worker/.env.example worker/.env

# 3. Edit .env with your credentials
nano .env
# Set:
# - DB_PASSWORD
# - JWT_SECRET
# - ADMIN_API_KEY
# - OXYLABS_USER / OXYLABS_PASS
# - BRIGHTDATA_USER / BRIGHTDATA_PASS

# 4. Start infrastructure (DB + Redis)
docker-compose -f docker-compose.infra.yml up -d

# 5. Wait for databases to be ready
sleep 10

# 6. Run database migrations
docker-compose exec postgres psql -U whatsapp -d whatsapp_automation -f /init.sql

# 7. Start master server
docker-compose -f docker-compose.master.yml up -d

# 8. Start workers (adjust number as needed)
docker-compose -f docker-compose.workers.yml up -d --scale worker=5

# 9. Start dashboard
docker-compose -f docker-compose.dashboard.yml up -d

# 10. Check status
docker-compose ps

# 11. View logs
docker-compose logs -f master
docker-compose logs -f worker-1
```

### 10.3 Adding More Workers

```bash
# Scale to 10 workers
docker-compose -f docker-compose.workers.yml up -d --scale worker=10

# Or add specific worker with custom config
docker run -d \
  --name wa_worker_custom \
  --network whatsapp_network \
  -e WORKER_ID=worker-custom \
  -e WORKER_PORT=3000 \
  -e MASTER_URL=http://master:5000 \
  -e MAX_ACCOUNTS=100 \
  -e PROXY_COUNTRY=DE \
  -v worker_custom_sessions:/app/sessions \
  whatsapp-worker:latest
```

### 10.4 Production Deployment

```bash
# 1. Build production images
docker-compose -f docker-compose.prod.yml build

# 2. Push to registry
docker tag whatsapp-master:latest your-registry/whatsapp-master:latest
docker push your-registry/whatsapp-master:latest

# 3. Deploy with Kubernetes/Swarm/etc.
kubectl apply -f k8s/
```

---

## סיכום

המערכת מורכבת מ:

1. **Master Server** - שרת מרכזי שמקבל את כל הבקשות ומפזר לworkers
2. **Workers** - קונטיינרים נפרדים, כל אחד עם הגדרות שונות (מדינה, פרוקסי)
3. **Dashboard** - ממשק ניהול מלא
4. **Anti-Ban** - מנוע מובנה עם כל האלגוריתמים

**הבא**:
- נתחיל לבנות את הקוד בפועל?
- נתחיל מהMaster Server או מהWorker?
- מה העדיפות הראשונה?
