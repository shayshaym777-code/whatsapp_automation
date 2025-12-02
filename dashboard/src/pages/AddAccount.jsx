import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
    WORKERS,
    connectAccountWithPairingCode,
    detectCountry,
    getWorkerByCountry,
    fetchAllAccounts
} from '../api/workers'

// v8.0: Add account page with session tracking
// Each phone can have up to 4 sessions (backups)

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
    const [searchParams] = useSearchParams()
    const existingPhone = searchParams.get('phone') // For adding more sessions
    
    const [phone, setPhone] = useState(existingPhone || '')
    const [selectedWorker, setSelectedWorker] = useState(WORKERS[0])
    const [pairingCode, setPairingCode] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [status, setStatus] = useState('idle') // idle, requesting, waiting, success, error
    const [sessionNumber, setSessionNumber] = useState(1) // Which session (1-4)
    const [existingSessions, setExistingSessions] = useState(0) // How many sessions already exist

    // Check existing sessions for this phone
    useEffect(() => {
        if (existingPhone) {
            checkExistingSessions(existingPhone)
        }
    }, [existingPhone])

    const checkExistingSessions = async (phoneNum) => {
        try {
            const accounts = await fetchAllAccounts()
            const account = accounts.find(a => a.phone === phoneNum)
            if (account) {
                const sessions = account.sessions_total || 1
                setExistingSessions(sessions)
                setSessionNumber(sessions + 1)
            }
        } catch (err) {
            console.error('Failed to check sessions:', err)
        }
    }

    // Auto-detect country and add prefix when phone changes
    const handlePhoneChange = (value) => {
        // Remove all non-digit characters except +
        let cleanValue = value.replace(/[^\d+]/g, '')
        
        setPhone(cleanValue)
        
        // Auto-detect country from prefix
        const country = detectCountry(cleanValue)
        const worker = getWorkerByCountry(country)
        setSelectedWorker(worker)

        // Check existing sessions
        if (cleanValue.length > 8) {
            checkExistingSessions(cleanValue)
        }
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
            // Send session_number to create worker for this session
            const data = await connectAccountWithPairingCode(cleanPhone, selectedWorker, true, sessionNumber)

            if (data.pairing_code) {
                setPairingCode(data.pairing_code)
                setStatus('waiting')
                // Start polling for connection status
                startPolling(cleanPhone, data.worker_id)
            } else if (data.status === 'already_connected') {
                // Double check - make sure it's really connected
                // Wait a moment for the account to appear
                await new Promise(resolve => setTimeout(resolve, 2000))
                const accounts = await fetchAllAccounts()
                const account = accounts.find(a => a.phone === cleanPhone)
                
                if (account && account.logged_in && account.connected) {
                    setStatus('success')
                    setExistingSessions(prev => {
                        // Update session count if this is a new session
                        const currentSessions = account.sessions_total || 1
                        return Math.max(prev, currentSessions)
                    })
                    setTimeout(() => navigate('/accounts'), 2000)
                } else {
                    // Not really connected - show error
                    setError(`Account is not connected. Status: logged_in=${account?.logged_in}, connected=${account?.connected}. Please try connecting again.`)
                    setStatus('error')
                }
            } else {
                setError(data.message || 'Unexpected response from server')
                setStatus('error')
            }
        } catch (err) {
            setError(err.message)
            setStatus('error')
        } finally {
            setLoading(false)
        }
    }

    const startPolling = (cleanPhone, workerId) => {
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
                // Check through master API (checks all workers)
                const res = await fetch(`/api/accounts`)
                const data = await res.json()
                const account = data.accounts?.find(a => a.phone === cleanPhone)

                // Make sure it's REALLY connected, not just logged_in
                if (account?.logged_in && account?.connected) {
                    clearInterval(poll)
                    setStatus('success')
                    // Update session count
                    setExistingSessions(prev => prev + 1)
                    setTimeout(() => navigate('/accounts'), 2000)
                } else if (account?.logged_in && !account?.connected) {
                    // Logged in but not connected - still waiting
                    console.log(`Account ${cleanPhone} logged in but not connected yet... (attempt ${attempts}/${maxAttempts})`)
                } else if (!account) {
                    // Account not found yet - still waiting
                    console.log(`Account ${cleanPhone} not found yet... (attempt ${attempts}/${maxAttempts})`)
                }
            } catch (err) {
                console.error('Polling error:', err)
            }
        }, 5000)
    }

    const remainingSessions = 4 - (existingSessions + (status === 'success' ? 1 : 0))
    const isAddingMoreSessions = existingPhone !== null

    return (
        <div className="max-w-2xl mx-auto space-y-8 animate-fade-in">
            {/* Header */}
            <div>
                <h2 className="text-3xl font-bold text-white mb-2">
                    {isAddingMoreSessions ? 'Add Session' : 'Add Account'}
                </h2>
                <p className="text-gray-400">
                    {isAddingMoreSessions 
                        ? `Adding backup session for ${existingPhone}`
                        : 'Connect a new WhatsApp account (scan up to 4 times for backup)'
                    }
                </p>
            </div>

            {/* Session Progress (if adding to existing phone) */}
            {(existingSessions > 0 || status === 'success') && (
                <div className="card bg-blue-500/10 border-blue-500/30">
                    <h3 className="text-lg font-semibold text-blue-400 mb-3">
                        📱 Session Progress for {phone}
                    </h3>
                    <div className="flex gap-2 mb-3">
                        {[1, 2, 3, 4].map(i => (
                            <div
                                key={i}
                                className={`flex-1 h-4 rounded ${
                                    i <= existingSessions + (status === 'success' ? 1 : 0)
                                        ? 'bg-green-500'
                                        : 'bg-gray-700'
                                }`}
                            />
                        ))}
                    </div>
                    <p className="text-gray-400 text-sm">
                        {existingSessions + (status === 'success' ? 1 : 0)}/4 sessions connected
                        {remainingSessions > 0 && status !== 'success' && (
                            <span className="text-yellow-400"> • Need {remainingSessions} more for full backup</span>
                        )}
                    </p>
                </div>
            )}

            {/* Form */}
            <div className="card">
                {/* Quick Country Prefix Buttons */}
                {!isAddingMoreSessions && (
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
                )}

                {/* Step 1: Phone Number */}
                <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-300 mb-3">
                        1. Phone Number
                    </label>
                    <input
                        type="tel"
                        value={phone}
                        onChange={(e) => handlePhoneChange(e.target.value)}
                        placeholder="+1234567890"
                        className="input text-2xl font-mono tracking-wider"
                        disabled={status === 'waiting' || isAddingMoreSessions}
                    />
                    {!isAddingMoreSessions && (
                        <p className="text-xs text-gray-500 mt-2">
                            Click a country button above or type the full number with country code
                        </p>
                    )}
                </div>

                {/* Session Number Selection */}
                <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-300 mb-3">
                        2. Session Number (1-4)
                    </label>
                    <div className="grid grid-cols-4 gap-3">
                        {[1, 2, 3, 4].map((num) => {
                            const isUsed = num <= existingSessions
                            return (
                                <button
                                    key={num}
                                    onClick={() => !isUsed && setSessionNumber(num)}
                                    disabled={isUsed || status === 'waiting'}
                                    className={`p-4 rounded-xl border transition-all duration-200 ${
                                        isUsed 
                                            ? 'bg-green-500/20 border-green-500 text-green-400 cursor-not-allowed'
                                            : sessionNumber === num
                                                ? 'bg-wa-green/20 border-wa-green text-white'
                                                : 'bg-wa-bg border-wa-border text-gray-400 hover:border-wa-green/50'
                                    }`}
                                >
                                    <div className="text-2xl mb-1">{isUsed ? '✅' : num}</div>
                                    <div className="text-xs">
                                        {isUsed ? 'Connected' : `Session ${num}`}
                                    </div>
                                </button>
                            )
                        })}
                    </div>
                </div>

                {/* Step 3: Worker Selection */}
                <div className="mb-6">
                    <label className="block text-sm font-medium text-gray-300 mb-3">
                        3. Worker (auto-detected: {selectedWorker.flag} {selectedWorker.country})
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
                            Waiting for pairing... (Session {sessionNumber})
                        </div>
                    </div>
                )}

                {/* Success */}
                {status === 'success' && (
                    <div className="mb-6 p-6 bg-green-500/20 border border-green-500/30 rounded-xl text-center">
                        <div className="text-5xl mb-3">✅</div>
                        <p className="text-green-400 font-semibold text-xl">
                            Session {sessionNumber} connected!
                        </p>
                        {remainingSessions > 0 ? (
                            <div className="mt-4">
                                <p className="text-yellow-400 text-sm mb-3">
                                    ⚠️ {remainingSessions} more session(s) needed for full backup
                                </p>
                                <button
                                    onClick={() => {
                                        setStatus('idle')
                                        setPairingCode(null)
                                        setSessionNumber(existingSessions + 2)
                                    }}
                                    className="btn-primary"
                                >
                                    ➕ Add Session {existingSessions + 2}
                                </button>
                            </div>
                        ) : (
                            <div className="mt-4">
                                <p className="text-green-400 text-sm mb-3">
                                    🎉 All 4 sessions connected! Full backup ready.
                                </p>
                                <button
                                    onClick={() => navigate('/accounts')}
                                    className="btn-primary"
                                >
                                    Go to Accounts
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Action Button */}
                {status !== 'success' && (
                    <button
                        onClick={requestPairingCode}
                        disabled={loading || !phone || status === 'waiting' || sessionNumber <= existingSessions}
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
                                Get Pairing Code (Session {sessionNumber})
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Info Box */}
            <div className="card">
                <h3 className="text-lg font-semibold text-white mb-4">📱 Why 4 Sessions?</h3>
                <div className="space-y-3 text-sm text-gray-400">
                    <p>
                        <strong className="text-white">Backup & Failover:</strong> Each phone can have up to 4 linked devices (sessions).
                        If one session disconnects, the system automatically switches to the next one.
                    </p>
                    <p>
                        <strong className="text-white">How it works:</strong>
                    </p>
                    <ul className="list-disc list-inside space-y-1 ml-4">
                        <li>Session 1 is active (sends messages)</li>
                        <li>Sessions 2-4 are backups (standby)</li>
                        <li>If Session 1 drops → Session 2 takes over automatically</li>
                        <li>All 4 down → Alert sent to Telegram</li>
                    </ul>
                    <p className="text-yellow-400 mt-4">
                        ⚠️ <strong>Important:</strong> Scan QR 4 times from different devices/browsers for each phone number!
                    </p>
                </div>
            </div>
        </div>
    )
}

export default AddAccount
