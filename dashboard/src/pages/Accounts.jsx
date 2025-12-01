import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
    WORKERS,
    fetchAllAccounts,
    triggerReconnect
} from '../api/workers'

// v8.0: Only 2 statuses - CONNECTED (🟢) or DISCONNECTED (🔴)
// Each phone can have up to 4 sessions (backups)

function Accounts() {
    const [accounts, setAccounts] = useState([])
    const [loading, setLoading] = useState(true)
    const [filter, setFilter] = useState('all') // all, connected, disconnected, incomplete

    useEffect(() => {
        fetchAccounts()
        // Auto-refresh every 30 seconds
        const interval = setInterval(fetchAccounts, 30000)
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

    // v8.0: Simple status - connected or disconnected
    const getStatus = (account) => {
        const sessions = account.sessions_connected || (account.connected && account.logged_in ? 1 : 0)
        if (sessions > 0) return 'CONNECTED'
        return 'DISCONNECTED'
    }

    // Get session counts
    const getSessionInfo = (account) => {
        const connected = account.sessions_connected || (account.connected && account.logged_in ? 1 : 0)
        const total = account.sessions_total || 4
        return { connected, total, remaining: 4 - total }
    }

    const connectedCount = accounts.filter(a => getStatus(a) === 'CONNECTED').length
    const disconnectedCount = accounts.filter(a => getStatus(a) === 'DISCONNECTED').length
    
    // Accounts that don't have all 4 sessions
    const incompleteCount = accounts.filter(a => {
        const info = getSessionInfo(a)
        return info.total < 4
    }).length

    const filteredAccounts = accounts.filter(account => {
        const status = getStatus(account)
        const info = getSessionInfo(account)
        switch (filter) {
            case 'connected': return status === 'CONNECTED'
            case 'disconnected': return status === 'DISCONNECTED'
            case 'incomplete': return info.total < 4
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
                    <p className="text-gray-400">WhatsApp accounts (4 sessions per phone for backup)</p>
                </div>
                <div className="flex gap-3 items-center">
                    <span className="text-gray-500 text-sm">Auto-refresh: 30s</span>
                    <button onClick={fetchAccounts} className="btn-secondary text-sm">
                        🔄 Refresh
                    </button>
                    <Link to="/accounts/add" className="btn-primary flex items-center gap-2">
                        <span>+</span>
                        Add Account
                    </Link>
                </div>
            </div>

            {/* Stats - 4 categories */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <button
                    onClick={() => setFilter('all')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'all' ? 'border-wa-green' : ''}`}
                >
                    <div className="text-3xl font-bold text-white">{accounts.length}</div>
                    <div className="text-gray-400 text-sm">Total Phones</div>
                </button>
                <button
                    onClick={() => setFilter('connected')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'connected' ? 'border-green-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-green-400">{connectedCount}</div>
                    <div className="text-gray-400 text-sm">🟢 Connected</div>
                </button>
                <button
                    onClick={() => setFilter('disconnected')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'disconnected' ? 'border-red-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-red-400">{disconnectedCount}</div>
                    <div className="text-gray-400 text-sm">🔴 Disconnected</div>
                </button>
                <button
                    onClick={() => setFilter('incomplete')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'incomplete' ? 'border-yellow-500' : ''}`}
                >
                    <div className="text-3xl font-bold text-yellow-400">{incompleteCount}</div>
                    <div className="text-gray-400 text-sm">⚠️ Need More Sessions</div>
                </button>
            </div>

            {/* Incomplete Sessions Warning */}
            {incompleteCount > 0 && (
                <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-4 flex items-center gap-3">
                    <span className="text-3xl">⚠️</span>
                    <div>
                        <h4 className="font-semibold text-yellow-400">
                            {incompleteCount} phone(s) need more sessions!
                        </h4>
                        <p className="text-gray-400 text-sm">
                            Each phone should have 4 sessions for backup. Scan QR more times to add sessions.
                        </p>
                    </div>
                </div>
            )}

            {/* Disconnected Warning */}
            {disconnectedCount > 0 && (
                <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-center gap-3">
                    <span className="text-3xl">🔴</span>
                    <div>
                        <h4 className="font-semibold text-red-400">
                            {disconnectedCount} account(s) disconnected!
                        </h4>
                        <p className="text-gray-400 text-sm">
                            All sessions are down. Need to scan QR code again.
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
                        <AccountCard
                            key={account.phone || index}
                            account={account}
                            status={getStatus(account)}
                            sessionInfo={getSessionInfo(account)}
                            onReconnect={() => handleReconnect(account)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

// v8.0: Account Card with Session Info
function AccountCard({ account, status, sessionInfo, onReconnect }) {
    const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }

    const isConnected = status === 'CONNECTED'
    const statusColor = isConnected ? 'green' : 'red'
    const statusIcon = isConnected ? '🟢' : '🔴'
    const statusLabel = isConnected ? 'Connected' : 'Disconnected'

    const { connected, total, remaining } = sessionInfo
    const needsMoreSessions = total < 4
    const allSessionsConnected = connected === 4

    // Session bar colors
    const getSessionColor = (index) => {
        if (index < connected) return 'bg-green-500'  // Connected
        if (index < total) return 'bg-red-500'        // Disconnected
        return 'bg-gray-700'                           // Not created yet
    }

    return (
        <div className={`card transition-all duration-300 ${needsMoreSessions ? 'border-yellow-500/30' : `border-${statusColor}-500/30`}`}>
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl ${
                        allSessionsConnected ? 'bg-green-500/20' : 
                        isConnected ? 'bg-green-500/20' : 'bg-red-500/20'
                    }`}>
                        {allSessionsConnected ? '✅' : statusIcon}
                    </div>
                    <div>
                        <h4 className="font-semibold text-white text-lg">{account.phone}</h4>
                        <p className="text-xs text-gray-500">
                            {countryFlags[account.workerCountry] || '🌍'} {account.worker}
                        </p>
                    </div>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                    allSessionsConnected ? 'bg-green-500/20 text-green-400' :
                    isConnected ? 'bg-green-500/20 text-green-400' : 
                    'bg-red-500/20 text-red-400'
                }`}>
                    {allSessionsConnected ? '4/4 ✓' : statusLabel}
                </span>
            </div>

            {/* Sessions Visual Bar */}
            <div className="mb-4">
                <div className="flex justify-between text-sm mb-2">
                    <span className="text-gray-400">Sessions</span>
                    <span className={connected > 0 ? 'text-green-400' : 'text-red-400'}>
                        {connected}/{total} connected
                    </span>
                </div>
                <div className="flex gap-1">
                    {[0, 1, 2, 3].map(i => (
                        <div
                            key={i}
                            className={`h-3 flex-1 rounded ${getSessionColor(i)}`}
                            title={
                                i < connected ? `Session ${i+1}: Connected` :
                                i < total ? `Session ${i+1}: Disconnected` :
                                `Session ${i+1}: Not created`
                            }
                        />
                    ))}
                </div>
                {needsMoreSessions && (
                    <p className="text-yellow-400 text-xs mt-2">
                        ⚠️ Need {4 - total} more session(s) - scan QR again!
                    </p>
                )}
            </div>

            {/* Status Details */}
            <div className="bg-wa-bg rounded-lg p-3 space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Status</span>
                    <span className={`text-${statusColor}-400 font-medium`}>
                        {statusIcon} {statusLabel}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Total Sessions</span>
                    <span className={total === 4 ? 'text-green-400' : 'text-yellow-400'}>
                        {total}/4 {total === 4 ? '✓' : `(need ${4-total} more)`}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Active Sessions</span>
                    <span className={connected > 0 ? 'text-green-400' : 'text-red-400'}>
                        {connected} active
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Messages Today</span>
                    <span className="text-gray-300">
                        {account.today_msgs || 0}
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

            {/* Actions */}
            <div className="flex gap-2 flex-wrap">
                {isConnected ? (
                    <>
                        <Link
                            to={`/send?from=${encodeURIComponent(account.phone)}`}
                            className="flex-1 py-2 px-3 bg-wa-green/20 text-wa-green rounded-lg text-sm font-medium
                             hover:bg-wa-green/30 transition-colors text-center"
                        >
                            📤 Send
                        </Link>
                        {needsMoreSessions && (
                            <Link
                                to={`/accounts/add?phone=${encodeURIComponent(account.phone)}`}
                                className="flex-1 py-2 px-3 bg-yellow-500/20 text-yellow-400 rounded-lg text-sm font-medium
                                 hover:bg-yellow-500/30 transition-colors text-center"
                            >
                                ➕ Add Session
                            </Link>
                        )}
                    </>
                ) : (
                    <button
                        onClick={onReconnect}
                        className="flex-1 py-2 px-3 bg-blue-500/20 text-blue-400 rounded-lg text-sm font-medium
                         hover:bg-blue-500/30 transition-colors text-center"
                    >
                        🔄 Reconnect
                    </button>
                )}
            </div>
        </div>
    )
}

export default Accounts
