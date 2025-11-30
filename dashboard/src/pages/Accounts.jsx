import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
    WORKERS,
    fetchAllAccounts,
    disconnectAccount,
    getAccountWarmup,
    cleanupAccounts
} from '../api/workers'

function Accounts() {
    const [accounts, setAccounts] = useState([])
    const [loading, setLoading] = useState(true)
    const [filter, setFilter] = useState('all') // all, connected, disconnected, warmup

    useEffect(() => {
        fetchAccounts()
    }, [])

    const fetchAccounts = async () => {
        setLoading(true)
        try {
            const allAccounts = await fetchAllAccounts()
            setAccounts(allAccounts)
        } catch (err) {
            console.error('Failed to fetch accounts:', err)
        } finally {
            setLoading(false)
        }
    }

    const handleDisconnect = async (account) => {
        if (!confirm(`Disconnect ${account.phone}?`)) return

        try {
            await disconnectAccount(account.phone, account.workerPort)
            fetchAccounts()
        } catch (err) {
            alert('Failed to disconnect: ' + err.message)
        }
    }

    const handleCleanup = async () => {
        if (!confirm('Remove all non-logged-in accounts from all workers?')) return

        try {
            await Promise.all(WORKERS.map(w => cleanupAccounts(w)))
            alert('Cleanup complete!')
            fetchAccounts()
        } catch (err) {
            alert('Cleanup failed: ' + err.message)
        }
    }

    const filteredAccounts = accounts.filter(account => {
        switch (filter) {
            case 'connected': return account.connected && account.logged_in
            case 'disconnected': return !account.connected || !account.logged_in
            case 'warmup': return !account.warmup_complete
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
                    <p className="text-gray-400">Manage connected WhatsApp accounts</p>
                </div>
                <div className="flex gap-3">
                    <button onClick={handleCleanup} className="btn-secondary text-sm">
                        🧹 Cleanup
                    </button>
                    <Link to="/accounts/add" className="btn-primary flex items-center gap-2">
                        <span>+</span>
                        Add Account
                    </Link>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <button
                    onClick={() => setFilter('all')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'all' ? 'border-wa-green' : ''}`}
                >
                    <div className="text-3xl font-bold text-white">{accounts.length}</div>
                    <div className="text-gray-400 text-sm">Total</div>
                </button>
                <button
                    onClick={() => setFilter('connected')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'connected' ? 'border-wa-green' : ''}`}
                >
                    <div className="text-3xl font-bold text-green-400">
                        {accounts.filter(a => a.connected && a.logged_in).length}
                    </div>
                    <div className="text-gray-400 text-sm">Connected</div>
                </button>
                <button
                    onClick={() => setFilter('disconnected')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'disconnected' ? 'border-wa-green' : ''}`}
                >
                    <div className="text-3xl font-bold text-yellow-400">
                        {accounts.filter(a => !a.connected || !a.logged_in).length}
                    </div>
                    <div className="text-gray-400 text-sm">Disconnected</div>
                </button>
                <button
                    onClick={() => setFilter('warmup')}
                    className={`card text-center cursor-pointer transition-all ${filter === 'warmup' ? 'border-wa-green' : ''}`}
                >
                    <div className="text-3xl font-bold text-orange-400">
                        {accounts.filter(a => !a.warmup_complete).length}
                    </div>
                    <div className="text-gray-400 text-sm">In Warmup</div>
                </button>
            </div>

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
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filteredAccounts.map((account, index) => (
                        <AccountCard
                            key={account.phone || index}
                            account={account}
                            onDisconnect={() => handleDisconnect(account)}
                        />
                    ))}
                </div>
            )}

            {/* Refresh Button */}
            <div className="text-center">
                <button onClick={fetchAccounts} className="btn-secondary">
                    🔄 Refresh
                </button>
            </div>
        </div>
    )
}

function AccountCard({ account, onDisconnect }) {
    const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }
    const isConnected = account.connected
    const isLoggedIn = account.logged_in
    const isActive = isConnected && isLoggedIn

    return (
        <div className={`card transition-all duration-300 ${isActive ? 'border-green-500/30' : 'border-yellow-500/30'
            }`}>
            <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className={`w-12 h-12 rounded-full flex items-center justify-center text-xl ${isActive ? 'bg-green-500/20' : 'bg-yellow-500/20'
                        }`}>
                        {countryFlags[account.workerCountry] || '📱'}
                    </div>
                    <div>
                        <h4 className="font-semibold text-white">{account.phone}</h4>
                        <p className="text-xs text-gray-500">{account.worker}</p>
                    </div>
                </div>
                <span className={`badge ${isActive ? 'badge-success' : 'badge-warning'}`}>
                    {isActive ? 'Active' : 'Inactive'}
                </span>
            </div>

            <div className="space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Connected</span>
                    <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
                        {isConnected ? '✓ Yes' : '✗ No'}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Logged In</span>
                    <span className={isLoggedIn ? 'text-green-400' : 'text-red-400'}>
                        {isLoggedIn ? '✓ Yes' : '✗ No'}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Warmup</span>
                    <span className={account.warmup_complete ? 'text-green-400' : 'text-orange-400'}>
                        {account.warmup_complete ? '✓ Complete' : '🔥 In Progress'}
                    </span>
                </div>
                <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Device ID</span>
                    <span className="text-gray-300 font-mono text-xs">
                        {account.device_id?.slice(0, 8) || 'N/A'}...
                    </span>
                </div>
            </div>

            <div className="flex gap-2">
                <Link
                    to={`/send?from=${encodeURIComponent(account.phone)}`}
                    className="flex-1 py-2 px-3 bg-wa-green/20 text-wa-green rounded-lg text-sm font-medium
                     hover:bg-wa-green/30 transition-colors text-center"
                >
                    Send Message
                </Link>
                <button
                    onClick={onDisconnect}
                    className="py-2 px-3 bg-red-500/20 text-red-400 rounded-lg text-sm font-medium
                     hover:bg-red-500/30 transition-colors"
                >
                    ✗
                </button>
            </div>
        </div>
    )
}

export default Accounts
