import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const WORKERS = [
  { id: 'worker-1', name: 'Worker 1 (US)', country: 'US', port: 3001, flag: '🇺🇸' },
  { id: 'worker-2', name: 'Worker 2 (Israel)', country: 'IL', port: 3002, flag: '🇮🇱' },
  { id: 'worker-3', name: 'Worker 3 (UK)', country: 'GB', port: 3003, flag: '🇬🇧' },
]

function AddAccount() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [selectedWorker, setSelectedWorker] = useState(WORKERS[0])
  const [pairingCode, setPairingCode] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('idle') // idle, requesting, waiting, success, error

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
      const res = await fetch(`http://localhost:${selectedWorker.port}/accounts/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: cleanPhone })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to get pairing code')
      }

      if (data.pairing_code) {
        setPairingCode(data.pairing_code)
        setStatus('waiting')
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

  const checkStatus = async () => {
    const cleanPhone = phone.replace(/\s/g, '').startsWith('+') 
      ? phone.replace(/\s/g, '') 
      : '+' + phone.replace(/\s/g, '')

    try {
      const res = await fetch(`http://localhost:${selectedWorker.port}/accounts`)
      const data = await res.json()
      
      const account = data.accounts?.find(a => a.phone === cleanPhone)
      if (account?.logged_in) {
        setStatus('success')
        setTimeout(() => navigate('/accounts'), 2000)
      }
    } catch (err) {
      console.error('Status check failed:', err)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">Add Account</h2>
        <p className="text-gray-400">Connect a new WhatsApp account using pairing code</p>
      </div>

      {/* Form */}
      <div className="card">
        {/* Step 1: Select Worker */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            1. Select Worker (by country)
          </label>
          <div className="grid grid-cols-3 gap-3">
            {WORKERS.map((worker) => (
              <button
                key={worker.id}
                onClick={() => setSelectedWorker(worker)}
                className={`p-4 rounded-xl border transition-all duration-200 ${
                  selectedWorker.id === worker.id
                    ? 'bg-wa-green/20 border-wa-green text-white'
                    : 'bg-wa-bg border-wa-border text-gray-400 hover:border-wa-green/50'
                }`}
              >
                <div className="text-2xl mb-2">{worker.flag}</div>
                <div className="text-sm font-medium">{worker.country}</div>
                <div className="text-xs text-gray-500">Port {worker.port}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Step 2: Phone Number */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            2. Enter Phone Number
          </label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+972501234567"
            className="input"
            disabled={status === 'waiting'}
          />
          <p className="text-xs text-gray-500 mt-2">
            Include country code (e.g., +972 for Israel, +1 for US)
          </p>
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
            <div className="text-4xl font-mono font-bold text-wa-green tracking-widest mb-4">
              {pairingCode}
            </div>
            <div className="text-sm text-gray-400 space-y-1">
              <p>1. Open WhatsApp on your phone</p>
              <p>2. Go to Settings → Linked Devices → Link a Device</p>
              <p>3. Tap "Link with phone number instead"</p>
              <p>4. Enter the code above</p>
            </div>
            <button 
              onClick={checkStatus}
              className="mt-4 btn-secondary text-sm"
            >
              Check Status
            </button>
          </div>
        )}

        {/* Success */}
        {status === 'success' && (
          <div className="mb-6 p-6 bg-green-500/20 border border-green-500/30 rounded-xl text-center">
            <div className="text-4xl mb-3">✅</div>
            <p className="text-green-400 font-semibold">Account connected successfully!</p>
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

      {/* Instructions */}
      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">📋 Instructions</h3>
        <ol className="space-y-3 text-gray-400 text-sm">
          <li className="flex gap-3">
            <span className="text-wa-green font-bold">1.</span>
            Select the worker that matches your phone's country for best proxy matching
          </li>
          <li className="flex gap-3">
            <span className="text-wa-green font-bold">2.</span>
            Enter your full phone number with country code
          </li>
          <li className="flex gap-3">
            <span className="text-wa-green font-bold">3.</span>
            Click "Get Pairing Code" and wait for the 8-digit code
          </li>
          <li className="flex gap-3">
            <span className="text-wa-green font-bold">4.</span>
            Open WhatsApp → Settings → Linked Devices → Link a Device
          </li>
          <li className="flex gap-3">
            <span className="text-wa-green font-bold">5.</span>
            Tap "Link with phone number instead" and enter the code
          </li>
        </ol>
      </div>
    </div>
  )
}

export default AddAccount

