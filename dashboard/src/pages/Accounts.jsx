import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
    WORKERS,
    fetchAllAccounts,
    triggerReconnect
} from '../api/workers'

// v8.0: Only 2 statuses - CONNECTED (🟢) or DISCONNECTED (🔴)
// At least 1 session connected = CONNECTED

function Accounts() {
    const [accounts, setAccounts] = useState([])
    const [loading, setLoading] = useState(true)
    const [filter, setFilter] = useState('all') // all, connected, disconnected

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
        if (account.connected && account.logged_in) return 'CONNECTED'
        return 'DISCONNECTED'
    }

    const connectedCount = accounts.filter(a => getStatus(a) === 'CONNECTED').length
    const disconnectedCount = accounts.filter(a => getStatus(a) === 'DISCONNECTED').length

    const filteredAccounts = accounts.filter(account => {
        const status = getStatus(account)
        switch (filter) {
            case 'connected': return status === 'CONNECTED'
            case 'disconnected': return status === 'DISCONNECTED'
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
                    <p className="text-gray-400">WhatsApp accounts status (4 sessions per phone)</p>
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

            {/* Stats - Only 2 statuses */}
            <div className="grid grid-cols-3 gap-4">
                <button
                    onClick={() => setFilter('all')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'all' ? 'border-wa-green' : ''}`}
                >
                    <div className="text-3xl font-bold text-white">{accounts.length}</div>
                    <div className="text-gray-400 text-sm">Total</div>
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
            </div>

            {/* Disconnected Warning */}
            {disconnectedCount > 0 && (
                <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-center gap-3">
                    <span className="text-3xl">🔴</span>
                    <div>
                        <h4 className="font-semibold text-red-400">
                            {disconnectedCount} account(s) disconnected!
                        </h4>
                        <p className="text-gray-400 text-sm">
                            Need to scan QR code again for these accounts.
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
                            onReconnect={() => handleReconnect(account)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

// v8.0: Simplified Account Card
function AccountCard({ account, status, onReconnect }) {
    const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }
    
    const isConnected = status === 'CONNECTED'
    const statusColor = isConnected ? 'green' : 'red'
    const statusIcon = isConnected ? '🟢' : '🔴'
    const statusLabel = isConnected ? 'Connected' : 'Disconnected'

    // Sessions info (if available)
    const sessionsConnected = account.sessions_connected || (isConnected ? 1 : 0)
    const sessionsTotal = account.sessions_total || 4

    return (
        <div className={`card transition-all duration-300 border-${statusColor}-500/30`}>
            {/* Header */}
            <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className={`w-14 h-14 rounded-full flex items-center justify-center text-2xl bg-${statusColor}-500/20`}>
                        {statusIcon}
                    </div>
                    <div>
                        <h4 className="font-semibold text-white text-lg">{account.phone}</h4>
                        <p className="text-xs text-gray-500">
                            {countryFlags[account.workerCountry] || '🌍'} {account.worker}
                        </p>
                    </div>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                    isConnected 
                        ? 'bg-green-500/20 text-green-400' 
                        : 'bg-red-500/20 text-red-400'
                }`}>
                    {statusLabel}
                </span>
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
                    <span className="text-gray-400">Sessions</span>
                    <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
                        {sessionsConnected}/{sessionsTotal} connected
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
                    <Link
                        to={`/send?from=${encodeURIComponent(account.phone)}`}
                        className="flex-1 py-2 px-3 bg-wa-green/20 text-wa-green rounded-lg text-sm font-medium
                         hover:bg-wa-green/30 transition-colors text-center"
                    >
                        📤 Send Message
                    </Link>
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
