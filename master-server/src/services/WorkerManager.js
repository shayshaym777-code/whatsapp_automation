// Worker Manager - Auto-create workers when accounts are added
// Creates one worker per account automatically

const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const execPromise = util.promisify(exec);

class WorkerManager {
    constructor() {
        this.dockerComposePath = process.env.DOCKER_COMPOSE_PATH || '/root/whatsapp_automation/docker/docker-compose.yml';
        this.dockerComposeDir = path.dirname(this.dockerComposePath);
        this.maxWorkers = parseInt(process.env.MAX_WORKERS) || 100;
    }

    // Get next available worker number
    async getNextWorkerNumber() {
        try {
            // Read current docker-compose.yml
            const composeContent = await fs.readFile(this.dockerComposePath, 'utf8');
            
            // Find highest worker number
            const workerMatches = composeContent.match(/worker-(\d+):/g) || [];
            let maxWorkerNum = 0;
            
            for (const match of workerMatches) {
                const num = parseInt(match.match(/\d+/)[0]);
                if (num > maxWorkerNum) {
                    maxWorkerNum = num;
                }
            }
            
            const nextNum = maxWorkerNum + 1;
            
            if (nextNum > this.maxWorkers) {
                throw new Error(`Maximum workers limit reached (${this.maxWorkers})`);
            }
            
            return nextNum;
        } catch (err) {
            logger.error(`[WorkerManager] Failed to get next worker number: ${err.message}`);
            throw err;
        }
    }

    // Find worker with no accounts (empty worker)
    async findEmptyWorker() {
        try {
            const axios = require('axios');
            const workers = this.loadWorkers();
            
            for (const worker of workers) {
                try {
                    const response = await axios.get(`${worker.url}/accounts`, { timeout: 5000 });
                    const accounts = response.data?.accounts || [];
                    const connectedAccounts = accounts.filter(acc => acc.logged_in && acc.connected);
                    
                    if (connectedAccounts.length === 0) {
                        logger.info(`[WorkerManager] Found empty worker: ${worker.id}`);
                        return worker;
                    }
                } catch (err) {
                    // Worker might be down, skip it
                    continue;
                }
            }
            
            return null;
        } catch (err) {
            logger.error(`[WorkerManager] Failed to find empty worker: ${err.message}`);
            return null;
        }
    }

    // Load workers from env vars
    loadWorkers() {
        const workers = [];
        const workerCount = parseInt(process.env.WORKER_COUNT) || 0;
        
        if (workerCount > 0) {
            for (let i = 1; i <= workerCount; i++) {
                const workerId = `worker-${i}`;
                const workerUrl = process.env[`WORKER_${i}_URL`] || `http://worker-${i}:3001`;
                workers.push({ id: workerId, url: workerUrl });
            }
        } else {
            // Auto-detect from WORKER_N_URL env vars
            for (let i = 1; i <= 100; i++) {
                const workerUrl = process.env[`WORKER_${i}_URL`];
                if (workerUrl) {
                    const workerId = `worker-${i}`;
                    workers.push({ id: workerId, url: workerUrl });
                }
            }
        }
        
        return workers;
    }

    // Create a new worker automatically
    async createWorkerForAccount(phone, country = 'US') {
        try {
            // First, try to find an empty worker
            const emptyWorker = await this.findEmptyWorker();
            if (emptyWorker) {
                logger.info(`[WorkerManager] Using existing empty worker: ${emptyWorker.id} for ${phone}`);
                return emptyWorker;
            }

            // No empty worker found - create new one
            logger.info(`[WorkerManager] No empty worker found, creating new worker for ${phone}...`);
            
            const workerNum = await this.getNextWorkerNumber();
            const workerId = `worker-${workerNum}`;
            const port = 3000 + workerNum;
            
            // Generate unique seed
            const seed = `auto-${workerId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            // Add worker to docker-compose.yml
            await this.addWorkerToCompose(workerId, workerNum, port, seed, country);
            
            // Update .env file
            await this.addWorkerToEnv(workerNum, workerId, port);
            
            // Start the new worker
            await this.startWorker(workerId);
            
            // Wait for worker to be ready
            await this.waitForWorkerReady(workerId, port);
            
            const newWorker = {
                id: workerId,
                url: `http://${workerId}:3001`,
                port: port
            };
            
            logger.info(`[WorkerManager] ✅ Created and started new worker: ${workerId} for ${phone}`);
            return newWorker;
            
        } catch (err) {
            logger.error(`[WorkerManager] Failed to create worker for ${phone}: ${err.message}`);
            throw err;
        }
    }

    // Add worker to docker-compose.yml
    async addWorkerToCompose(workerId, workerNum, port, seed, country) {
        try {
            const composeContent = await fs.readFile(this.dockerComposePath, 'utf8');
            
            // Find where to insert (before volumes section)
            const volumesIndex = composeContent.indexOf('volumes:');
            if (volumesIndex === -1) {
                throw new Error('Could not find volumes section in docker-compose.yml');
            }
            
            // Generate worker service definition
            const workerService = this.generateWorkerService(workerId, workerNum, port, seed, country);
            
            // Insert before volumes
            const beforeVolumes = composeContent.substring(0, volumesIndex);
            const afterVolumes = composeContent.substring(volumesIndex);
            
            const newContent = beforeVolumes + workerService + '\n\n' + afterVolumes;
            
            // Add volumes
            const volumesSection = this.generateWorkerVolumes(workerNum);
            const volumesIndex2 = newContent.indexOf('volumes:');
            const volumesContent = newContent.substring(volumesIndex2);
            const volumesEnd = volumesContent.indexOf('\nnetworks:');
            
            if (volumesEnd !== -1) {
                const beforeVolumes2 = newContent.substring(0, volumesIndex2 + volumesEnd);
                const afterVolumes2 = newContent.substring(volumesIndex2 + volumesEnd);
                const finalContent = beforeVolumes2 + volumesSection + '\n' + afterVolumes2;
                
                await fs.writeFile(this.dockerComposePath, finalContent, 'utf8');
            } else {
                await fs.writeFile(this.dockerComposePath, newContent, 'utf8');
            }
            
            logger.info(`[WorkerManager] Added ${workerId} to docker-compose.yml`);
        } catch (err) {
            logger.error(`[WorkerManager] Failed to add worker to compose: ${err.message}`);
            throw err;
        }
    }

    // Generate worker service definition
    generateWorkerService(workerId, workerNum, port, seed, country) {
        const containerName = `wa_worker_${workerNum}`;
        
        return `  # ============================================
  # WORKER ${workerNum} - Auto-created for account
  # ============================================
  ${workerId}:
    build:
      context: ../worker
      dockerfile: Dockerfile
    container_name: ${containerName}
    env_file:
      - .env
    environment:
      WORKER_ID: \${WORKER_${workerNum}_ID:-${workerId}}
      WORKER_PORT: 3001
      DEVICE_SEED: \${WORKER_${workerNum}_SEED:-${seed}}
      PROXY_COUNTRY: \${WORKER_${workerNum}_COUNTRY:-${country}}
      MASTER_URL: http://master:5000
      LOG_LEVEL: \${LOG_LEVEL:-info}
      PROXY_HOST: \${PROXY_HOST:-}
      PROXY_PORT: \${PROXY_PORT:-}
      PROXY_USER: \${PROXY_USER:-}
      PROXY_PASS: \${WORKER_${workerNum}_PROXY_PASS:-}
      PROXY_TYPE: \${PROXY_TYPE:-socks5}
      PROXY_LIST: \${WORKER_${workerNum}_PROXY_LIST:-}
    volumes:
      - worker${workerNum}_sessions:/data/sessions
      - worker${workerNum}_qrcodes:/data/qrcodes
      - worker${workerNum}_logs:/data/logs
    ports:
      - "${port}:3001"
    depends_on:
      master:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    restart: unless-stopped
    networks:
      - wa_network`;
    }

    // Generate worker volumes
    generateWorkerVolumes(workerNum) {
        return `  worker${workerNum}_sessions:
    driver: local
  worker${workerNum}_qrcodes:
    driver: local
  worker${workerNum}_logs:
    driver: local`;
    }

    // Add worker to .env file
    async addWorkerToEnv(workerNum, workerId, port) {
        try {
            const envPath = path.join(this.dockerComposeDir, '.env');
            let envContent = '';
            
            try {
                envContent = await fs.readFile(envPath, 'utf8');
            } catch (err) {
                // .env doesn't exist, create it
                envContent = '';
            }
            
            // Add worker URL if not exists
            const workerUrlVar = `WORKER_${workerNum}_URL`;
            if (!envContent.includes(workerUrlVar)) {
                envContent += `\n${workerUrlVar}=http://${workerId}:3001\n`;
            }
            
            // Update WORKER_COUNT
            if (envContent.includes('WORKER_COUNT=')) {
                envContent = envContent.replace(/WORKER_COUNT=\d+/, `WORKER_COUNT=${workerNum}`);
            } else {
                envContent += `\nWORKER_COUNT=${workerNum}\n`;
            }
            
            await fs.writeFile(envPath, envContent, 'utf8');
            logger.info(`[WorkerManager] Updated .env with ${workerId}`);
        } catch (err) {
            logger.error(`[WorkerManager] Failed to update .env: ${err.message}`);
            throw err;
        }
    }

    // Start worker using docker compose
    async startWorker(workerId) {
        try {
            const { stdout, stderr } = await execPromise(
                `cd ${this.dockerComposeDir} && docker compose up -d --build ${workerId}`,
                { timeout: 120000 } // 2 minutes timeout
            );
            
            logger.info(`[WorkerManager] Started ${workerId}: ${stdout}`);
            if (stderr) {
                logger.warn(`[WorkerManager] ${workerId} stderr: ${stderr}`);
            }
        } catch (err) {
            logger.error(`[WorkerManager] Failed to start ${workerId}: ${err.message}`);
            throw err;
        }
    }

    // Wait for worker to be ready
    async waitForWorkerReady(workerId, port, maxAttempts = 30) {
        const axios = require('axios');
        const workerUrl = `http://${workerId}:3001`;
        
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await axios.get(`${workerUrl}/health`, { timeout: 3000 });
                if (response.data && response.data.healthy) {
                    logger.info(`[WorkerManager] ${workerId} is ready!`);
                    return true;
                }
            } catch (err) {
                // Not ready yet, wait and retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        throw new Error(`Worker ${workerId} did not become ready within ${maxAttempts * 2} seconds`);
    }

    // Get or create worker for account
    async getOrCreateWorkerForAccount(phone, country = 'US') {
        try {
            // Try to find empty worker first
            const emptyWorker = await this.findEmptyWorker();
            if (emptyWorker) {
                return emptyWorker;
            }
            
            // Create new worker
            return await this.createWorkerForAccount(phone, country);
        } catch (err) {
            logger.error(`[WorkerManager] Failed to get/create worker: ${err.message}`);
            // Fallback to first available worker
            const workers = this.loadWorkers();
            return workers[0] || null;
        }
    }
}

module.exports = new WorkerManager();

