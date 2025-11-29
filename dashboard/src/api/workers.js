// Worker configuration
export const WORKERS = [
  { id: 'worker-1', name: 'Worker 1', country: 'US', port: 3001, url: '/worker-1' },
  { id: 'worker-2', name: 'Worker 2', country: 'IL', port: 3002, url: '/worker-2' },
  { id: 'worker-3', name: 'Worker 3', country: 'GB', port: 3003, url: '/worker-3' },
]

// Country to worker mapping
export const COUNTRY_WORKER_MAP = {
  '+1': 'worker-1',   // US
  '+972': 'worker-2', // Israel
  '+44': 'worker-3',  // UK
  '+49': 'worker-3',  // Germany (fallback to UK)
  '+33': 'worker-3',  // France (fallback to UK)
}

// Get worker for a phone number based on country code
export function getWorkerForPhone(phone) {
  for (const [prefix, workerId] of Object.entries(COUNTRY_WORKER_MAP)) {
    if (phone.startsWith(prefix)) {
      return WORKERS.find(w => w.id === workerId)
    }
  }
  // Default to worker-1 (US)
  return WORKERS[0]
}

// Detect country from phone number
export function detectCountry(phone) {
  if (phone.startsWith('+1')) return { code: 'US', name: 'United States', flag: '🇺🇸' }
  if (phone.startsWith('+972')) return { code: 'IL', name: 'Israel', flag: '🇮🇱' }
  if (phone.startsWith('+44')) return { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' }
  if (phone.startsWith('+49')) return { code: 'DE', name: 'Germany', flag: '🇩🇪' }
  if (phone.startsWith('+33')) return { code: 'FR', name: 'France', flag: '🇫🇷' }
  if (phone.startsWith('+81')) return { code: 'JP', name: 'Japan', flag: '🇯🇵' }
  if (phone.startsWith('+86')) return { code: 'CN', name: 'China', flag: '🇨🇳' }
  if (phone.startsWith('+91')) return { code: 'IN', name: 'India', flag: '🇮🇳' }
  if (phone.startsWith('+55')) return { code: 'BR', name: 'Brazil', flag: '🇧🇷' }
  return { code: 'UN', name: 'Unknown', flag: '🌍' }
}

// API functions
export async function fetchWorkerHealth(worker) {
  try {
    const response = await fetch(`${worker.url}/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) throw new Error('Worker not responding')
    return await response.json()
  } catch (error) {
    console.error(`Failed to fetch health for ${worker.id}:`, error)
    return null
  }
}

export async function fetchWorkerAccounts(worker) {
  try {
    const response = await fetch(`${worker.url}/accounts`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok) throw new Error('Failed to fetch accounts')
    const data = await response.json()
    return data.accounts || []
  } catch (error) {
    console.error(`Failed to fetch accounts for ${worker.id}:`, error)
    return []
  }
}

export async function requestPairingCode(worker, phone) {
  const response = await fetch(`${worker.url}/accounts/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.message || 'Failed to get pairing code')
  }
  return await response.json()
}

export async function sendMessage(worker, fromPhone, toPhone, message) {
  const response = await fetch(`${worker.url}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_phone: fromPhone,
      to_phone: toPhone,
      message: message,
    }),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.message || 'Failed to send message')
  }
  return await response.json()
}

export async function disconnectAccount(worker, phone) {
  const response = await fetch(`${worker.url}/accounts/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  })
  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.message || 'Failed to disconnect account')
  }
  return await response.json()
}

