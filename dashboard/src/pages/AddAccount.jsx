import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    WORKERS,
    connectAccountWithPairingCode,
    detectCountry,
    getWorkerByCountry,
    getWarmupStages
} from '../api/workers'

// Country prefixes
const COUNTRY_PREFIXES = {
    US: '+1',
    IL: '+972',
    GB: '+44',
    CA: '+1',
    AU: '+61',
    DE: '+49',
    FR: '+33',
}

function AddAccount() {
    const navigate = useNavigate()
    const [phone, setPhone] = useState('')
    const [selectedWorker, setSelectedWorker] = useState(WORKERS[0])
    const [pairingCode, setPairingCode] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [status, setStatus] = useState('idle') // idle, requesting, waiting, success, error
    const [skipWarmup, setSkipWarmup] = useState(false)

    // Auto-detect country and add prefix when phone changes
    const handlePhoneChange = (value) => {
        // Remove all non-digit characters except +
        let cleanValue = value.replace(/[^\d+]/g, '')
        
        setPhone(cleanValue)
        
        // Auto-detect country from prefix
        const country = detectCountry(cleanValue)
        const worker = getWorkerByCountry(country)
        setSelectedWorker(worker)
    }

    // Add country prefix
    const addPrefix = (countryCode) => {
        const prefix = COUNTRY_PREFIXES[countryCode] || '+1'
        if (!phone.startsWith('+')) {
            setPhone(prefix + phone)
        } else if (!phone.startsWith(prefix)) {
            // Replace existing prefix
            const phoneWithoutPrefix = phone.replace(/^\+\d+/, '')
            setPhone(prefix + phoneWithoutPrefix)
        }
        
        // Update worker
        const worker = getWorkerByCountry(countryCode)
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
            const data = await connectAccountWithPairingCode(cleanPhone, selectedWorker, skipWarmup)

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
                const res = await fetch(`/worker${selectedWorker.id.replace('worker-', '')}/accounts`)
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
                {/* Quick Country Prefix Buttons */}
                <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-300 mb-3">
                        Quick Prefix
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <button
                            onClick={() => addPrefix('US')}
                            className="px-4 py-2 bg-wa-bg border border-wa-border rounded-lg hover:border-wa-green transition-colors"
                        >
                            🇺🇸 +1 (US)
                        </button>
                        <button
                            onClick={() => addPrefix('IL')}
                            className="px-4 py-2 bg-wa-bg border border-wa-border rounded-lg hover:border-wa-green transition-colors"
                        >
                            🇮🇱 +972 (IL)
                        </button>
                        <button
                            onClick={() => addPrefix('GB')}
                            className="px-4 py-2 bg-wa-bg border border-wa-border rounded-lg hover:border-wa-green transition-colors"
                        >
                            🇬🇧 +44 (UK)
                        </button>
                    </div>
                </div>

                {/* Step 1: Phone Number */}
                <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-300 mb-3">
                        1. Enter Phone Number
                    </label>
                    <input
                        type="tel"
                        value={phone}
                        onChange={(e) => handlePhoneChange(e.target.value)}
                        placeholder="+1234567890"
                        className="input text-2xl font-mono tracking-wider"
                        disabled={status === 'waiting'}
                    />
                    <p className="text-xs text-gray-500 mt-2">
                        Click a country button above or type the full number with country code
                    </p>
                </div>

                {/* Step 2: Worker Selection */}
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
                                className={`p-4 rounded-xl border transition-all duration-200 ${selectedWorker.id === worker.id
                                        ? 'bg-wa-green/20 border-wa-green text-white'
                                        : 'bg-wa-bg border-wa-border text-gray-400 hover:border-wa-green/50'
                                    } ${status === 'waiting' ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                                <div className="text-2xl mb-2">{worker.flag}</div>
                                <div className="text-sm font-medium">{worker.country}</div>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Skip Warmup Checkbox */}
                <div className="mb-6">
                    <label className="flex items-center gap-3 cursor-pointer group">
                        <div className="relative">
                            <input
                                type="checkbox"
                                checked={skipWarmup}
                                onChange={(e) => setSkipWarmup(e.target.checked)}
                                className="sr-only"
                                disabled={status === 'waiting'}
                            />
                            <div className={`w-6 h-6 rounded border-2 transition-all ${
                                skipWarmup 
                                    ? 'bg-wa-green border-wa-green' 
                                    : 'border-gray-500 group-hover:border-wa-green'
                            }`}>
                                {skipWarmup && (
                                    <svg className="w-4 h-4 text-white m-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                    </svg>
                                )}
                            </div>
                        </div>
                        <div>
                            <span className="text-white font-medium">Skip Warmup</span>
                            <p className="text-xs text-gray-500">
                                Check this for accounts that don't need warmup (existing/trusted accounts)
                            </p>
                        </div>
                    </label>
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
            {!skipWarmup && (
                <div className="card">
                    <h3 className="text-lg font-semibold text-white mb-4">🔥 Auto Warmup</h3>
                    <p className="text-gray-400 text-sm mb-4">
                        New accounts automatically enter a warmup period to prevent bans.
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
            )}

            {/* Skip Warmup Warning */}
            {skipWarmup && (
                <div className="card border-yellow-500/30">
                    <h3 className="text-lg font-semibold text-yellow-400 mb-2">⚠️ Warmup Disabled</h3>
                    <p className="text-gray-400 text-sm">
                        This account will be able to send up to 100 messages/day immediately.
                        Only skip warmup for accounts that are already established and trusted.
                    </p>
                </div>
            )}
        </div>
    )
}

export default AddAccount
