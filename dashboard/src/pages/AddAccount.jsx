import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { 
  WORKERS, 
  connectAccountWithPairingCode,
  detectCountry,
  getWorkerByCountry,
  getWarmupStages
} from '../api/workers'

function AddAccount() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [selectedWorker, setSelectedWorker] = useState(WORKERS[0])
  const [pairingCode, setPairingCode] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('idle') // idle, requesting, waiting, success, error

  // Auto-detect country when phone changes
  const handlePhoneChange = (value) => {
    setPhone(value)
    const country = detectCountry(value)
    const worker = getWorkerByCountry(country)
    setSelectedWorker(worker)
  }

  const requestPairingCode = async () => {
    if (!phone) {
      setError('Please enter a phone number')
      return
    }

    // Clean phone number
    let cleanPhone = phone.replace(/\s/g, '')
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = '+' + cleanPhone
    }

    setLoading(true)
    setError(null)
    setStatus('requesting')
    setPairingCode(null)

    try {
      const data = await connectAccountWithPairingCode(cleanPhone, selectedWorker)

      if (data.pairing_code) {
        setPairingCode(data.pairing_code)
        setStatus('waiting')
        // Start polling for connection status
        startPolling(cleanPhone)
      } else if (data.status === 'already_connected') {
        setStatus('success')
        setTimeout(() => navigate('/accounts'), 2000)
      }
    } catch (err) {
      setError(err.message)
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  const startPolling = (cleanPhone) => {
    let attempts = 0
    const maxAttempts = 60 // 5 minutes (every 5 seconds)
    
    const poll = setInterval(async () => {
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(poll)
        setError('Pairing timeout. Please try again.')
        setStatus('error')
        return
      }

      try {
        const res = await fetch(`http://localhost:${selectedWorker.port}/accounts`)
        const data = await res.json()
        const account = data.accounts?.find(a => a.phone === cleanPhone)
        
        if (account?.logged_in) {
          clearInterval(poll)
          setStatus('success')
          setTimeout(() => navigate('/accounts'), 2000)
        }
      } catch (err) {
        console.error('Polling error:', err)
      }
    }, 5000)
  }

  const warmupStages = getWarmupStages()

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">Add Account</h2>
        <p className="text-gray-400">Connect a new WhatsApp account using pairing code</p>
      </div>

      {/* Form */}
      <div className="card">
        {/* Step 1: Phone Number (auto-detects worker) */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            1. Enter Phone Number
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => handlePhoneChange(e.target.value)}
            placeholder="+972501234567"
            className="input"
            disabled={status === 'waiting'}
          />
          <p className="text-xs text-gray-500 mt-2">
            Include country code. Worker will be auto-selected based on country.
          </p>
        </div>

        {/* Step 2: Worker Selection (auto-selected but can override) */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            2. Worker (auto-detected: {selectedWorker.flag} {selectedWorker.country})
          </label>
          <div className="grid grid-cols-3 gap-3">
            {WORKERS.map((worker) => (
              <button
                key={worker.id}
                onClick={() => setSelectedWorker(worker)}
                disabled={status === 'waiting'}
                className={`p-4 rounded-xl border transition-all duration-200 ${
                  selectedWorker.id === worker.id
                    ? 'bg-wa-green/20 border-wa-green text-white'
                    : 'bg-wa-bg border-wa-border text-gray-400 hover:border-wa-green/50'
                } ${status === 'waiting' ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="text-2xl mb-2">{worker.flag}</div>
                <div className="text-sm font-medium">{worker.country}</div>
                <div className="text-xs text-gray-500">Port {worker.port}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
            {error}
          </div>
        )}

        {/* Pairing Code Display */}
        {pairingCode && status === 'waiting' && (
          <div className="mb-6 p-6 bg-wa-green/10 border border-wa-green/30 rounded-xl text-center">
            <p className="text-gray-400 mb-3">Enter this code in WhatsApp:</p>
            <div className="text-5xl font-mono font-bold text-wa-green tracking-[0.3em] mb-4">
              {pairingCode}
            </div>
            <div className="text-sm text-gray-400 space-y-2 text-left max-w-md mx-auto">
              <p className="flex gap-2"><span>1.</span> Open WhatsApp on your phone</p>
              <p className="flex gap-2"><span>2.</span> Go to <strong>Settings → Linked Devices</strong></p>
              <p className="flex gap-2"><span>3.</span> Tap <strong>"Link a Device"</strong></p>
              <p className="flex gap-2"><span>4.</span> Tap <strong>"Link with phone number instead"</strong></p>
              <p className="flex gap-2"><span>5.</span> Enter the code above</p>
            </div>
            <div className="mt-4 flex items-center justify-center gap-2 text-sm text-gray-500">
              <div className="w-4 h-4 border-2 border-wa-green border-t-transparent rounded-full animate-spin"></div>
              Waiting for pairing...
            </div>
          </div>
        )}

        {/* Success */}
        {status === 'success' && (
          <div className="mb-6 p-6 bg-green-500/20 border border-green-500/30 rounded-xl text-center">
            <div className="text-5xl mb-3">✅</div>
            <p className="text-green-400 font-semibold text-xl">Account connected!</p>
            <p className="text-gray-400 text-sm mt-2">Redirecting to accounts...</p>
          </div>
        )}

        {/* Action Button */}
        {status !== 'success' && (
          <button
            onClick={requestPairingCode}
            disabled={loading || !phone || status === 'waiting'}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Getting Code...
              </>
            ) : status === 'waiting' ? (
              'Waiting for pairing...'
            ) : (
              <>
                <span>🔗</span>
                Get Pairing Code
              </>
            )}
          </button>
        )}
      </div>

      {/* Warmup Info */}
      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">🔥 Auto Warmup</h3>
        <p className="text-gray-400 text-sm mb-4">
          New accounts automatically enter a 3-day warmup period to prevent bans.
        </p>
        <div className="space-y-3">
          {warmupStages.map((stage) => (
            <div key={stage.day} className="flex items-center gap-3 text-sm">
              <div className="w-8 h-8 rounded-full bg-orange-500/20 text-orange-400 flex items-center justify-center font-bold">
                {stage.day}
              </div>
              <div>
                <span className="text-white">{stage.description}</span>
                <span className="text-gray-500 ml-2">({stage.maxMessages} msgs max)</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Instructions */}
      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">📋 Tips</h3>
        <ul className="space-y-2 text-gray-400 text-sm">
          <li className="flex gap-2">
            <span className="text-wa-green">•</span>
            Use the correct country worker for your phone number
          </li>
          <li className="flex gap-2">
            <span className="text-wa-green">•</span>
            Each worker uses a proxy from its country for anti-ban
          </li>
          <li className="flex gap-2">
            <span className="text-wa-green">•</span>
            Don't skip the warmup period - it protects your account
          </li>
          <li className="flex gap-2">
            <span className="text-wa-green">•</span>
            The pairing code expires in 60 seconds - be quick!
          </li>
        </ul>
      </div>
    </div>
  )
}

export default AddAccount
