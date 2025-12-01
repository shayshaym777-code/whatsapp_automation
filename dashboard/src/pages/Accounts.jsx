import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
    WORKERS,
    fetchAllAccounts,
    skipAccountWarmup,
    triggerReconnect,
    setAccountWarmup
} from '../api/workers'

function Accounts() {
    const [accounts, setAccounts] = useState([])
    const [loading, setLoading] = useState(true)
    const [filter, setFilter] = useState('all') // all, healthy, blocked, suspicious, disconnected, warmup

    useEffect(() => {
        fetchAccounts()
        // Auto-refresh every 60 seconds
        const interval = setInterval(fetchAccounts, 60000)
        return () => clearInterval(interval)
    }, [])

    const fetchAccounts = async () => {
        try {
            const allAccounts = await fetchAllAccounts()
            setAccounts(allAccounts)
        } catch (err) {
            console.error('Failed to fetch accounts:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleReconnect = async (account) => {
        try {
            await triggerReconnect(account.phone, account.workerPort)
            alert(`Reconnecting ${account.phone}...`)
            setTimeout(fetchAccounts, 2000)
        } catch (err) {
            alert('Failed to reconnect: ' + err.message)
        }
    }

    const handleSkipWarmup = async (account) => {
        if (!confirm(`Skip warmup for ${account.phone}? This will allow full message capacity immediately.`)) return

        try {
            await skipAccountWarmup(account.phone, account.workerPort)
            alert(`Warmup skipped for ${account.phone}!`)
            fetchAccounts()
        } catch (err) {
            alert('Failed to skip warmup: ' + err.message)
        }
    }

    const handleToggleWarmup = async (account, enableWarmup) => {
        const action = enableWarmup ? 'enable warmup (with daily limits)' : 'disable warmup (no limits - veteran mode)'
        if (!confirm(`${action} for ${account.phone}?`)) return

        try {
            await setAccountWarmup(account.phone, account.workerPort, enableWarmup)
            alert(`${account.phone} is now in ${enableWarmup ? 'WARMUP' : 'VETERAN'} mode!`)
            fetchAccounts()
        } catch (err) {
            alert('Failed to toggle warmup: ' + err.message)
        }
    }

    // Calculate stats by health status
    const healthyCount = accounts.filter(a => getHealthStatus(a) === 'HEALTHY').length
    const blockedCount = accounts.filter(a => getHealthStatus(a) === 'BLOCKED').length
    const suspiciousCount = accounts.filter(a => getHealthStatus(a) === 'SUSPICIOUS').length
    const disconnectedCount = accounts.filter(a => getHealthStatus(a) === 'DISCONNECTED').length
    const warmupCount = accounts.filter(a => !a.warmup_complete && a.connected && a.logged_in).length

    const filteredAccounts = accounts.filter(account => {
        const status = getHealthStatus(account)
        switch (filter) {
            case 'healthy': return status === 'HEALTHY'
            case 'blocked': return status === 'BLOCKED'
            case 'suspicious': return status === 'SUSPICIOUS'
            case 'disconnected': return status === 'DISCONNECTED'
            case 'warmup': return !account.warmup_complete && account.connected && account.logged_in
            default: return true
        }
    })

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="w-8 h-8 border-2 border-wa-green border-t-transparent rounded-full animate-spin"></div>
            </div>
        )
    }

    return (
        <div className="space-y-8 animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                    <h2 className="text-3xl font-bold text-white mb-2">Accounts</h2>
                    <p className="text-gray-400">Live status of all WhatsApp accounts</p>
                </div>
                <div className="flex gap-3 items-center">
                    <span className="text-gray-500 text-sm">Auto-refresh: 60s</span>
                    <button onClick={fetchAccounts} className="btn-secondary text-sm">
                        🔄 Refresh Now
                    </button>
                    <Link to="/accounts/add" className="btn-primary flex items-center gap-2">
                        <span>+</span>
                        Add Account
                    </Link>
                </div>
            </div>

            {/* Stats by Health Status */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
                <button
                    onClick={() => setFilter('all')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'all' ? 'border-wa-green' : ''}`}
                >
                    <div className="text-3xl font-bold text-white">{accounts.length}</div>
                    <div className="text-gray-400 text-sm">Total</div>
                </button>
                <button
                    onClick={() => setFilter('healthy')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'healthy' ? 'border-green-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-green-400">{healthyCount}</div>
                    <div className="text-gray-400 text-sm">🟢 Healthy</div>
                </button>
                <button
                    onClick={() => setFilter('warmup')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'warmup' ? 'border-orange-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-orange-400">{warmupCount}</div>
                    <div className="text-gray-400 text-sm">🔥 Warmup</div>
                </button>
                <button
                    onClick={() => setFilter('suspicious')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'suspicious' ? 'border-yellow-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-yellow-400">{suspiciousCount}</div>
                    <div className="text-gray-400 text-sm">🟠 Suspicious</div>
                </button>
                <button
                    onClick={() => setFilter('disconnected')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'disconnected' ? 'border-yellow-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-yellow-400">{disconnectedCount}</div>
                    <div className="text-gray-400 text-sm">🟡 Disconnected</div>
                </button>
                <button
                    onClick={() => setFilter('blocked')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'blocked' ? 'border-red-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-red-400">{blockedCount}</div>
                    <div className="text-gray-400 text-sm">🔴 Blocked</div>
                </button>
            </div>

            {/* Blocked Warning */}
            {blockedCount > 0 && (
                <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-center gap-3">
                    <span className="text-3xl">🚨</span>
                    <div>
                        <h4 className="font-semibold text-red-400">
                            {blockedCount} account(s) may be BLOCKED!
                        </h4>
                        <p className="text-gray-400 text-sm">
                            These accounts are not receiving/sending messages. They may need to be replaced.
                        </p>
                    </div>
                </div>
            )}

            {/* Accounts List */}
            {filteredAccounts.length === 0 ? (
                <div className="card text-center py-12">
                    <div className="text-6xl mb-4">📱</div>
                    <h3 className="text-xl font-semibold text-white mb-2">
                        {filter === 'all' ? 'No accounts connected' : `No ${filter} accounts`}
                    </h3>
                    <p className="text-gray-400 mb-6">
                        {filter === 'all' ? 'Add your first WhatsApp account to get started' : 'Try a different filter'}
                    </p>
                    {filter === 'all' && (
                        <Link to="/accounts/add" className="btn-primary inline-block">
                            Add Account
                        </Link>
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filteredAccounts.map((account, index) => (
                        <DetailedAccountCard
                            key={account.phone || index}
                            account={account}
                            onReconnect={() => handleReconnect(account)}
                            onSkipWarmup={() => handleSkipWarmup(account)}
                            onToggleWarmup={(enableWarmup) => handleToggleWarmup(account, enableWarmup)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

// Get health status from account data
function getHealthStatus(account) {
    if (!account.connected) return 'DISCONNECTED'
    if (!account.logged_in) return 'DISCONNECTED'

    // Check for block indicators
    if (account.last_error) {
        const err = account.last_error.toLowerCase()
        if (err.includes('banned') || err.includes('blocked') ||
            err.includes('restricted') || err.includes('unusual')) {
            return 'BLOCKED'
        }
    }

    // Check for suspicious activity (no messages delivered recently)
    if (account.consecutive_failures > 3) {
        return 'SUSPICIOUS'
    }

    return 'HEALTHY'
}

// Get stage info from account age
function getStageInfo(account) {
    const ageHours = account.account_age_hours || 0
    const ageDays = ageHours / 24

    if (account.warmup_complete) {
        if (ageDays >= 60) return { name: 'Veteran', emoji: '🎖️', limit: 200 }
        return { name: 'Adult', emoji: '🧑', limit: 100 }
    }

    if (ageDays <= 3) return { name: 'New Born', emoji: '🐣', limit: 5 }
    if (ageDays <= 7) return { name: 'Baby', emoji: '👶', limit: 15 }
    if (ageDays <= 14) return { name: 'Toddler', emoji: '🧒', limit: 30 }
    if (ageDays <= 30) return { name: 'Teen', emoji: '👦', limit: 50 }
    return { name: 'Adult', emoji: '🧑', limit: 100 }
}

function DetailedAccountCard({ account, onReconnect, onSkipWarmup, onToggleWarmup }) {
    const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }
    const healthStatus = getHealthStatus(account)
    const stageInfo = getStageInfo(account)
    const isWarmup = !account.warmup_complete && account.connected && account.logged_in
    const isVeteran = account.warmup_complete || account.is_veteran

    const ageHours = account.account_age_hours || 0
    const ageDays = Math.floor(ageHours / 24)

    // Calculate time since last alive
    const lastAlive = account.last_warmup_sent ? new Date(account.last_warmup_sent) : null
    const timeSinceAlive = lastAlive ? Math.round((Date.now() - lastAlive) / 60000) : null

    const statusConfig = {
        HEALTHY: { color: 'green', icon: '🟢', label: 'Healthy' },
        BLOCKED: { color: 'red', icon: '🔴', label: 'BLOCKED!' },
        SUSPICIOUS: { color: 'yellow', icon: '🟠', label: 'Suspicious' },
        DISCONNECTED: { color: 'yellow', icon: '🟡', label: 'Disconnected' }
    }

    const status = statusConfig[healthStatus]

    return (
        <div className={`card transition-all duration-300 border-${status.color}-500/30`}>
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-${status.color}-500/20`}>
                        {status.icon}
                    </div>
                    <div>
                        <h4 className="font-semibold text-white text-lg">{account.phone}</h4>
                        <p className="text-xs text-gray-500">
                            {countryFlags[account.workerCountry] || '🌍'} {account.worker}
                        </p>
                    </div>
                </div>
                <span className={`badge badge-${status.color === 'green' ? 'success' : status.color === 'red' ? 'error' : 'warning'}`}>
                    {status.label}
                </span>
            </div>

            {/* Status Details */}
            <div className="bg-wa-bg rounded-lg p-3 space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Status</span>
                    <span className={`text-${status.color}-400 font-medium`}>
                        {status.icon} {status.label}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Connected</span>
                    <span className={account.connected ? 'text-green-400' : 'text-red-400'}>
                        {account.connected ? '✅ Yes' : '❌ No'}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Logged In</span>
                    <span className={account.logged_in ? 'text-green-400' : 'text-red-400'}>
                        {account.logged_in ? '✅ Yes' : '❌ No'}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Last Alive</span>
                    <span className="text-gray-300">
                        {timeSinceAlive !== null
                            ? timeSinceAlive < 60
                                ? `${timeSinceAlive} min ago`
                                : `${Math.round(timeSinceAlive / 60)} hours ago`
                            : 'Unknown'}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Messages Today</span>
                    <span className="text-gray-300">
                        {account.today_msgs || 0} / {stageInfo.limit}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Stage</span>
                    <span className="text-gray-300">
                        {stageInfo.emoji} {stageInfo.name} (Day {ageDays})
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Warmup</span>
                    <span className={account.warmup_complete ? 'text-green-400' : 'text-orange-400'}>
                        {account.warmup_complete ? '✅ Complete' : '🔥 In Progress'}
                    </span>
                </div>
            </div>

            {/* Error Message */}
            {account.last_error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4">
                    <div className="text-red-400 text-sm font-medium">⚠️ Error:</div>
                    <div className="text-gray-400 text-xs mt-1">{account.last_error}</div>
                </div>
            )}

            {/* Block Warning */}
            {healthStatus === 'BLOCKED' && (
                <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4">
                    <div className="text-red-400 text-sm font-semibold">🚨 This account may be banned!</div>
                    <div className="text-gray-400 text-xs mt-1">
                        Last successful message: {timeSinceAlive ? `${Math.round(timeSinceAlive / 60)} hours ago` : 'Unknown'}
                    </div>
                </div>
            )}

            {/* Actions - NO DELETE BUTTON */}
            <div className="flex gap-2 flex-wrap">
                {healthStatus === 'HEALTHY' && (
                    <Link
                        to={`/send?from=${encodeURIComponent(account.phone)}`}
                        className="flex-1 py-2 px-3 bg-wa-green/20 text-wa-green rounded-lg text-sm font-medium
                         hover:bg-wa-green/30 transition-colors text-center"
                    >
                        📤 Send Message
                    </Link>
                )}

                {/* Warmup Toggle Button */}
                {healthStatus === 'HEALTHY' && (
                    isVeteran ? (
                        <button
                            onClick={() => onToggleWarmup(true)}
                            className="py-2 px-3 bg-orange-500/20 text-orange-400 rounded-lg text-sm font-medium
                             hover:bg-orange-500/30 transition-colors"
                            title="Enable warmup mode (with daily limits)"
                        >
                            🔥 Enable Warmup
                        </button>
                    ) : (
                        <button
                            onClick={() => onToggleWarmup(false)}
                            className="py-2 px-3 bg-purple-500/20 text-purple-400 rounded-lg text-sm font-medium
                             hover:bg-purple-500/30 transition-colors"
                            title="Disable warmup (veteran mode - no daily limits)"
                        >
                            🎖️ Make Veteran
                        </button>
                    )
                )}

                {healthStatus === 'DISCONNECTED' && (
                    <button
                        onClick={onReconnect}
                        className="flex-1 py-2 px-3 bg-blue-500/20 text-blue-400 rounded-lg text-sm font-medium
                         hover:bg-blue-500/30 transition-colors text-center"
                    >
                        🔄 Reconnect
                    </button>
                )}

                {healthStatus === 'SUSPICIOUS' && (
                    <div className="flex-1 py-2 px-3 bg-yellow-500/10 text-yellow-400 rounded-lg text-sm text-center">
                        ⚠️ Needs Attention
                    </div>
                )}

                {healthStatus === 'BLOCKED' && (
                    <div className="flex-1 py-2 px-3 bg-red-500/10 text-red-400 rounded-lg text-sm text-center">
                        🔴 Account Blocked
                    </div>
                )}
            </div>
        </div>
    )
}

export default Accounts
