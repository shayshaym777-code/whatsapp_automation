// ============================================
// WhatsApp Automation - API Client
// ============================================

// API Configuration
export const API_KEY = 'sk_live_abc123xyz789def456'
export const MASTER_API = '/api'  // Proxied through nginx

// Workers Configuration
export const WORKERS = [
  { 
    id: 'worker-1', 
    name: 'Worker 1', 
    country: 'US', 
    flag: '🇺🇸',
    port: 3001,
    proxyPath: '/worker1',  // nginx proxy path
    devUrl: 'http://localhost:3001'  // Direct access for dev
  },
  { 
    id: 'worker-2', 
    name: 'Worker 2', 
    country: 'IL', 
    flag: '🇮🇱',
    port: 3002,
    proxyPath: '/worker2',
    devUrl: 'http://localhost:3002'
  },
  { 
    id: 'worker-3', 
    name: 'Worker 3', 
    country: 'GB', 
    flag: '🇬🇧',
    port: 3003,
    proxyPath: '/worker3',
    devUrl: 'http://localhost:3003'
  },
]

// Country to Worker mapping
const COUNTRY_WORKER_MAP = {
    'US': 'worker-1',
    '+1': 'worker-1',
    'IL': 'worker-2',
    '+972': 'worker-2',
    'GB': 'worker-3',
    '+44': 'worker-3',
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get headers with API key
 */
export function getHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'Authorization': `Bearer ${API_KEY}`
    }
}

/**
 * Detect country from phone number
 */
export function detectCountry(phone) {
    if (!phone) return 'US'

    const cleanPhone = phone.replace(/\s/g, '')

    if (cleanPhone.startsWith('+972') || cleanPhone.startsWith('972')) return 'IL'
    if (cleanPhone.startsWith('+1') || cleanPhone.startsWith('1')) return 'US'
    if (cleanPhone.startsWith('+44') || cleanPhone.startsWith('44')) return 'GB'

    return 'US' // Default
}

/**
 * Get worker by country
 */
export function getWorkerByCountry(country) {
    const workerId = COUNTRY_WORKER_MAP[country] || COUNTRY_WORKER_MAP['+1']
    return WORKERS.find(w => w.id === workerId) || WORKERS[0]
}

/**
 * Get worker URL (handles both dev and prod)
 * In production: uses nginx proxy paths (/worker1, /worker2, /worker3)
 * In development: uses direct localhost URLs
 */
function getWorkerUrl(worker) {
  // In production (Docker), use nginx proxy paths
  if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
    // Use relative path - nginx will proxy to the correct worker
    return worker.proxyPath
  }
  // In development, use direct URL
  return worker.devUrl
}

// ============================================
// Worker Health & Status
// ============================================

/**
 * Fetch health status from a worker
 */
export async function fetchWorkerHealth(worker) {
    try {
        const url = getWorkerUrl(worker)
        const res = await fetch(`${url}/health`, {
            method: 'GET',
            headers: getHeaders(),
            signal: AbortSignal.timeout(5000)
        })

        if (!res.ok) return { status: 'offline', error: res.statusText }

        const data = await res.json()
        return { status: 'online', ...data }
    } catch (error) {
        return { status: 'offline', error: error.message }
    }
}

/**
 * Fetch all workers health status
 */
export async function fetchAllWorkersHealth() {
    const results = await Promise.all(
        WORKERS.map(async (worker) => {
            const health = await fetchWorkerHealth(worker)
            return { ...worker, ...health }
        })
    )
    return results
}

// ============================================
// Account Management
// ============================================

/**
 * Fetch accounts from a specific worker
 */
export async function fetchWorkerAccounts(worker) {
    try {
        const url = getWorkerUrl(worker)
        const res = await fetch(`${url}/accounts`, {
            method: 'GET',
            headers: getHeaders(),
            signal: AbortSignal.timeout(10000)
        })

        if (!res.ok) return []

        const data = await res.json()
        return (data.accounts || []).map(acc => ({
            ...acc,
            worker: worker.name,
            workerId: worker.id,
            workerPort: worker.port,
            workerCountry: worker.country,
            workerFlag: worker.flag
        }))
    } catch (error) {
        console.error(`Failed to fetch accounts from ${worker.id}:`, error)
        return []
    }
}

/**
 * Fetch accounts from all workers
 */
export async function fetchAllAccounts() {
    const results = await Promise.all(
        WORKERS.map(worker => fetchWorkerAccounts(worker))
    )
    return results.flat()
}

/**
 * Connect account with pairing code
 */
export async function connectAccountWithPairingCode(phone, worker) {
    const url = getWorkerUrl(worker)
    const res = await fetch(`${url}/accounts/pair`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ phone })
    })

    if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to get pairing code')
    }

    return res.json()
}

/**
 * Disconnect an account
 */
export async function disconnectAccount(phone, workerPort) {
    const worker = WORKERS.find(w => w.port === workerPort)
    if (!worker) throw new Error('Worker not found')

    const url = getWorkerUrl(worker)
    const res = await fetch(`${url}/accounts/${encodeURIComponent(phone)}/disconnect`, {
        method: 'POST',
        headers: getHeaders()
    })

    if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to disconnect')
    }

    return res.json()
}

// ============================================
// Message Sending
// ============================================

/**
 * Send a single message
 */
export async function sendMessage(fromPhone, toPhone, message, workerPort) {
    const worker = WORKERS.find(w => w.port === workerPort)
    if (!worker) throw new Error('Worker not found')

    const url = getWorkerUrl(worker)
    const res = await fetch(`${url}/send`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
            from_phone: fromPhone,
            to_phone: toPhone,
            message: message
        })
    })

    if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to send message')
    }

    return res.json()
}

/**
 * Send bulk messages through master server
 */
export async function sendBulkMessages(messages) {
    const res = await fetch(`${MASTER_API}/messages/bulk-send`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ messages })
    })

    if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to send bulk messages')
    }

    return res.json()
}

// ============================================
// Warmup System
// ============================================

/**
 * Get warmup status from a worker
 */
export async function getWarmupStatus(worker) {
    try {
        const url = getWorkerUrl(worker)
        const res = await fetch(`${url}/warmup/status`, {
            method: 'GET',
            headers: getHeaders(),
            signal: AbortSignal.timeout(5000)
        })

        if (!res.ok) return { accounts: [] }

        return res.json()
    } catch (error) {
        console.error(`Failed to get warmup status from ${worker.id}:`, error)
        return { accounts: [] }
    }
}

/**
 * Get warmup status from all workers
 */
export async function getAllWarmupStatus() {
    const results = await Promise.all(
        WORKERS.map(async (worker) => {
            const status = await getWarmupStatus(worker)
            return {
                worker: worker.id,
                workerName: worker.name,
                ...status
            }
        })
    )
    return results
}

/**
 * Get warmup status for a specific account
 */
export async function getAccountWarmup(phone, workerPort) {
    const worker = WORKERS.find(w => w.port === workerPort)
    if (!worker) return null

    const status = await getWarmupStatus(worker)
    return status.accounts?.find(a => a.phone === phone) || null
}

/**
 * Warm all accounts (trigger warmup for all new accounts)
 */
export async function warmAllAccounts() {
    const res = await fetch(`${MASTER_API}/accounts/warm-all`, {
        method: 'POST',
        headers: getHeaders()
    })

    if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to warm accounts')
    }

    return res.json()
}

/**
 * Register account for warmup
 */
export async function registerAccountForWarmup(phone, workerPort) {
    const worker = WORKERS.find(w => w.port === workerPort)
    if (!worker) throw new Error('Worker not found')

    const url = getWorkerUrl(worker)
    const res = await fetch(`${url}/warmup/register`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ phone })
    })

    if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to register for warmup')
    }

    return res.json()
}

/**
 * Get warmup stages configuration
 */
export function getWarmupStages() {
    return [
        { day: 1, maxMessages: 5, description: 'Day 1: Very light activity' },
        { day: 2, maxMessages: 10, description: 'Day 2: Light activity' },
        { day: 3, maxMessages: 20, description: 'Day 3: Normal warmup complete' },
    ]
}

// ============================================
// Monitor & Stats
// ============================================

/**
 * Get monitor stats from a worker
 */
export async function getMonitorStats(worker) {
    try {
        const url = getWorkerUrl(worker)
        const res = await fetch(`${url}/monitor/stats`, {
            method: 'GET',
            headers: getHeaders(),
            signal: AbortSignal.timeout(5000)
        })

        if (!res.ok) return null

        return res.json()
    } catch (error) {
        console.error(`Failed to get monitor stats from ${worker.id}:`, error)
        return null
    }
}

/**
 * Cleanup inactive accounts
 */
export async function cleanupAccounts(worker) {
    const url = getWorkerUrl(worker)
    const res = await fetch(`${url}/accounts/cleanup`, {
        method: 'POST',
        headers: getHeaders()
    })

    if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to cleanup accounts')
    }

    return res.json()
}

// ============================================
// Master Server API
// ============================================

/**
 * Get system health from master
 */
export async function getMasterHealth() {
    try {
        const res = await fetch(`${MASTER_API}/health`, {
            method: 'GET',
            headers: getHeaders(),
            signal: AbortSignal.timeout(5000)
        })

        if (!res.ok) return { status: 'offline' }

        return res.json()
    } catch (error) {
        return { status: 'offline', error: error.message }
    }
}

/**
 * Get all workers status from master
 */
export async function getWorkersFromMaster() {
    try {
        const res = await fetch(`${MASTER_API}/workers`, {
            method: 'GET',
            headers: getHeaders()
        })

        if (!res.ok) return []

        const data = await res.json()
        return data.workers || []
    } catch (error) {
        console.error('Failed to get workers from master:', error)
        return []
    }
}

