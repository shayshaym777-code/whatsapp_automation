import { useState, useEffect } from 'react'
import {
    WORKERS,
    fetchAllWorkersHealth,
    fetchAllAccounts,
    getMasterHealth,
    getAllWarmupStatus,
    warmAllAccounts
} from '../api/workers'

function Dashboard() {
    const [stats, setStats] = useState({
        totalAccounts: 0,
        activeAccounts: 0,
        warmupAccounts: 0,
        messagesSentToday: 0,
        workers: []
    })
    const [masterHealth, setMasterHealth] = useState(null)
    const [loading, setLoading] = useState(true)
    const [warmingAll, setWarmingAll] = useState(false)
    const [warmupStatus, setWarmupStatus] = useState([])

    useEffect(() => {
        fetchStats()
        const interval = setInterval(fetchStats, 15000) // Refresh every 15 seconds
        return () => clearInterval(interval)
    }, [])

    const fetchStats = async () => {
        try {
            // Fetch all data in parallel
            const [workersHealth, accounts, master, warmup] = await Promise.all([
                fetchAllWorkersHealth(),
                fetchAllAccounts(),
                getMasterHealth(),
                getAllWarmupStatus()
            ])

            const activeAccounts = accounts.filter(a => a.connected && a.logged_in).length
            const warmupAccounts = warmup.reduce((sum, w) =>
                sum + (w.accounts?.filter(a => !a.warmup_complete)?.length || 0), 0)

            setStats({
                totalAccounts: accounts.length,
                activeAccounts,
                warmupAccounts,
                messagesSentToday: 0, // TODO: Get from master
                workers: workersHealth
            })
            setMasterHealth(master)
            setWarmupStatus(warmup)
            setLoading(false)
        } catch (err) {
            console.error('Failed to fetch stats:', err)
            setLoading(false)
        }
    }

    const handleWarmAll = async () => {
        if (warmingAll) return
        setWarmingAll(true)
        try {
            await warmAllAccounts()
            alert('Warmup started for all eligible accounts!')
            fetchStats()
        } catch (err) {
            alert('Failed to warm accounts: ' + err.message)
        } finally {
            setWarmingAll(false)
        }
    }

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
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold text-white mb-2">Dashboard</h2>
                    <p className="text-gray-400">System overview and statistics</p>
                </div>
                <button
                    onClick={handleWarmAll}
                    disabled={warmingAll}
                    className="btn-primary flex items-center gap-2"
                >
                    {warmingAll ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                            Warming...
                        </>
                    ) : (
                        <>
                            🔥 Warm All Accounts
                        </>
                    )}
                </button>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                <StatCard
                    title="Total Accounts"
                    value={stats.totalAccounts}
                    icon="👥"
                    color="green"
                />
                <StatCard
                    title="Active"
                    value={stats.activeAccounts}
                    icon="✅"
                    color="blue"
                />
                <StatCard
                    title="In Warmup"
                    value={stats.warmupAccounts}
                    icon="🔥"
                    color="orange"
                />
                <StatCard
                    title="Messages Today"
                    value={stats.messagesSentToday}
                    icon="📨"
                    color="purple"
                />
                <StatCard
                    title="Workers Online"
                    value={stats.workers.filter(w => w.status === 'online').length}
                    subtitle={`of ${WORKERS.length}`}
                    icon="🖥️"
                    color="yellow"
                />
            </div>

            {/* Workers Status */}
            <div className="card">
                <h3 className="text-xl font-semibold text-white mb-6">Workers Status</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {stats.workers.map((worker) => (
                        <WorkerCard key={worker.id} worker={worker} />
                    ))}
                </div>
            </div>

            {/* Warmup Status */}
            {warmupStatus.some(w => w.accounts?.length > 0) && (
                <div className="card">
                    <h3 className="text-xl font-semibold text-white mb-6">🔥 Warmup Progress</h3>
                    <div className="space-y-4">
                        {warmupStatus.map((workerWarmup) => (
                            workerWarmup.accounts?.map((account) => (
                                <WarmupItem key={account.phone} account={account} worker={workerWarmup.workerName} />
                            ))
                        ))}
                    </div>
                </div>
            )}

            {/* System Health */}
            <div className="card">
                <h3 className="text-xl font-semibold text-white mb-6">System Health</h3>
                <div className="space-y-4">
                    <HealthItem
                        name="Master Server"
                        status={masterHealth?.status === 'ok' ? 'online' : 'offline'}
                        detail="Port 5000"
                    />
                    <HealthItem
                        name="PostgreSQL"
                        status="online"
                        detail="Port 5432"
                    />
                    <HealthItem
                        name="Redis"
                        status="online"
                        detail="Port 6379"
                    />
                    {stats.workers.map((worker) => (
                        <HealthItem
                            key={worker.id}
                            name={`${worker.name} (${worker.country})`}
                            status={worker.status}
                            detail={`Port ${worker.port}`}
                        />
                    ))}
                </div>
            </div>
        </div>
    )
}

function StatCard({ title, value, subtitle, icon, color }) {
    const colorClasses = {
        green: 'from-green-500/20 to-green-600/10 border-green-500/30',
        blue: 'from-blue-500/20 to-blue-600/10 border-blue-500/30',
        purple: 'from-purple-500/20 to-purple-600/10 border-purple-500/30',
        yellow: 'from-yellow-500/20 to-yellow-600/10 border-yellow-500/30',
        orange: 'from-orange-500/20 to-orange-600/10 border-orange-500/30',
    }

    return (
        <div className={`bg-gradient-to-br ${colorClasses[color]} border rounded-xl p-5`}>
            <div className="flex items-center justify-between mb-3">
                <span className="text-2xl">{icon}</span>
            </div>
            <div className="text-2xl font-bold text-white mb-1">
                {value}
                {subtitle && <span className="text-sm text-gray-400 font-normal ml-1">{subtitle}</span>}
            </div>
            <div className="text-gray-400 text-sm">{title}</div>
        </div>
    )
}

function WorkerCard({ worker }) {
    const isOnline = worker.status === 'online'
    const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }

    return (
        <div className={`bg-wa-bg border rounded-xl p-5 transition-all duration-300 ${isOnline ? 'border-green-500/30' : 'border-red-500/30'
            }`}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <span className="text-2xl">{countryFlags[worker.country] || '🌍'}</span>
                    <div>
                        <h4 className="font-semibold text-white">{worker.name}</h4>
                        <p className="text-xs text-gray-500">Port {worker.port}</p>
                    </div>
                </div>
                <span className={`badge ${isOnline ? 'badge-success' : 'badge-error'}`}>
                    {isOnline ? 'Online' : 'Offline'}
                </span>
            </div>
            <div className="text-xs text-gray-500">
                Proxy: {worker.country}
            </div>
        </div>
    )
}

function WarmupItem({ account, worker }) {
    const progress = account.warmup_complete ? 100 :
        Math.min(100, (account.account_age_hours / 72) * 100)

    const remainingHours = account.remaining_warmup
        ? Math.round(parseFloat(account.remaining_warmup) / 3600000000000)
        : 0

    return (
        <div className="bg-wa-bg rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                    <span className="text-lg">📱</span>
                    <div>
                        <span className="text-white font-medium">{account.phone}</span>
                        <span className="text-gray-500 text-sm ml-2">({worker})</span>
                    </div>
                </div>
                <span className={`badge ${account.warmup_complete ? 'badge-success' : 'badge-warning'}`}>
                    {account.warmup_complete ? 'Complete' : `${remainingHours}h left`}
                </span>
            </div>
            <div className="w-full bg-wa-border rounded-full h-2">
                <div
                    className="bg-gradient-to-r from-orange-500 to-green-500 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${progress}%` }}
                ></div>
            </div>
        </div>
    )
}

function HealthItem({ name, status, detail }) {
    const isOnline = status === 'online'

    return (
        <div className="flex items-center justify-between py-3 border-b border-wa-border last:border-0">
            <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500 pulse-green' : 'bg-red-500'}`}></div>
                <span className="text-white">{name}</span>
            </div>
            <div className="flex items-center gap-4">
                <span className="text-gray-500 text-sm">{detail}</span>
                <span className={`badge ${isOnline ? 'badge-success' : 'badge-error'}`}>
                    {isOnline ? 'Healthy' : 'Down'}
                </span>
            </div>
        </div>
    )
}

export default Dashboard
