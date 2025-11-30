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
 * @param {string} phone - Phone number with country code
 * @param {object} worker - Worker object
 * @param {boolean} skipWarmup - Skip warmup period (for established accounts)
 */
export async function connectAccountWithPairingCode(phone, worker, skipWarmup = false) {
  const url = getWorkerUrl(worker)
  const res = await fetch(`${url}/accounts/pair`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      phone,
      skip_warmup: skipWarmup
    })
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
  const res = await fetch(`${url}/accounts/disconnect`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ phone })
  })

  if (!res.ok) {
    const text = await res.text()
    let error = 'Failed to disconnect'
    try {
      const json = JSON.parse(text)
      error = json.error || json.message || error
    } catch (e) {
      error = text || error
    }
    throw new Error(error)
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
 * Get warmup stages configuration with realistic delays
 */
export function getWarmupStages() {
  return [
    { day: '1-3', name: 'new_born', minDays: 0, maxDays: 3, maxMessages: 5, msgsPerHour: 1, delay: '30-60s', description: '🐣 New Born' },
    { day: '4-7', name: 'baby', minDays: 4, maxDays: 7, maxMessages: 15, msgsPerHour: 3, delay: '20-40s', description: '👶 Baby' },
    { day: '8-14', name: 'toddler', minDays: 8, maxDays: 14, maxMessages: 30, msgsPerHour: 6, delay: '10-20s', description: '🧒 Toddler' },
    { day: '15-30', name: 'teen', minDays: 15, maxDays: 30, maxMessages: 50, msgsPerHour: 10, delay: '5-10s', description: '👦 Teen' },
    { day: '31-59', name: 'adult', minDays: 31, maxDays: 59, maxMessages: 100, msgsPerHour: 20, delay: '3-7s', description: '🧑 Adult' },
    { day: '60+', name: 'veteran', minDays: 60, maxDays: 9999, maxMessages: 200, msgsPerHour: 40, delay: '1-5s', description: '🎖️ Veteran' },
  ]
}

/**
 * Get warmup stages from server
 */
export async function fetchWarmupStages() {
  try {
    const res = await fetch(`${MASTER_API}/accounts/warmup/stages`, {
      headers: getHeaders()
    })
    if (!res.ok) return getWarmupStages()
    const data = await res.json()
    return data.stages || getWarmupStages()
  } catch (error) {
    return getWarmupStages()
  }
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

/**
 * Skip warmup for an account
 */
export async function skipAccountWarmup(phone, workerPort) {
  const worker = WORKERS.find(w => w.port === workerPort)
  if (!worker) throw new Error('Worker not found')

  const url = getWorkerUrl(worker)
  const res = await fetch(`${url}/accounts/${encodeURIComponent(phone)}/skip-warmup`, {
    method: 'POST',
    headers: getHeaders()
  })

  if (!res.ok) {
    const text = await res.text()
    let error = 'Failed to skip warmup'
    try {
      const json = JSON.parse(text)
      error = json.error || json.message || error
    } catch (e) {
      error = text || error
    }
    throw new Error(error)
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

// ============================================
// Account Health API
// ============================================

/**
 * Get account health/safety score
 */
export async function getAccountHealth(phone) {
  try {
    const res = await fetch(`${MASTER_API}/accounts/${encodeURIComponent(phone)}/health`, {
      headers: getHeaders()
    })
    if (!res.ok) return null
    return res.json()
  } catch (error) {
    console.error('Failed to get account health:', error)
    return null
  }
}

/**
 * Get health summary for all accounts
 */
export async function getHealthSummary() {
  try {
    const res = await fetch(`${MASTER_API}/accounts/health/summary`, {
      headers: getHeaders()
    })
    if (!res.ok) return null
    return res.json()
  } catch (error) {
    console.error('Failed to get health summary:', error)
    return null
  }
}

/**
 * Mark account as suspicious
 */
export async function markAccountSuspicious(phone, reason, suspendHours = 24) {
  const res = await fetch(`${MASTER_API}/accounts/${encodeURIComponent(phone)}/health/suspicious`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ reason, suspend_hours: suspendHours })
  })

  if (!res.ok) {
    const error = await res.json()
    throw new Error(error.error || 'Failed to mark account suspicious')
  }

  return res.json()
}

/**
 * Clear suspicious status
 */
export async function clearAccountSuspicious(phone) {
  const res = await fetch(`${MASTER_API}/accounts/${encodeURIComponent(phone)}/health/clear`, {
    method: 'POST',
    headers: getHeaders()
  })

  if (!res.ok) {
    const error = await res.json()
    throw new Error(error.error || 'Failed to clear suspicious status')
  }

  return res.json()
}

/**
 * Get recommended action for account based on safety score
 */
export function getRecommendedAction(safetyScore) {
  if (safetyScore >= 90) return { action: 'normal', color: 'green', description: 'Full speed' }
  if (safetyScore >= 80) return { action: 'slow', color: 'blue', description: 'Reduce 20%' }
  if (safetyScore >= 70) return { action: 'very_slow', color: 'yellow', description: 'Reduce 50%' }
  if (safetyScore >= 60) return { action: 'pause', color: 'orange', description: 'Pause & warmup' }
  return { action: 'stop', color: 'red', description: 'Stop immediately' }
}

