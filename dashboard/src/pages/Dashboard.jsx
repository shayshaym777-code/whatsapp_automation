import { useState, useEffect } from 'react'
import {
    WORKERS,
    fetchAllWorkersHealth,
    fetchAllAccounts,
    getMasterHealth,
    getAllWarmupStatus,
    warmAllAccounts,
    getHealthSummary,
    getWarmupStages
} from '../api/workers'

function Dashboard() {
    const [stats, setStats] = useState({
        totalAccounts: 0,
        activeAccounts: 0,
        warmupAccounts: 0,
        sendingAccounts: 0,
        messagesSentToday: 0,
        workers: [],
        accounts: []
    })
    const [masterHealth, setMasterHealth] = useState(null)
    const [healthSummary, setHealthSummary] = useState(null)
    const [loading, setLoading] = useState(true)
    const [warmingAll, setWarmingAll] = useState(false)
    const [warmupStatus, setWarmupStatus] = useState([])
    const [proxyStats, setProxyStats] = useState({})

    useEffect(() => {
        fetchStats()
        const interval = setInterval(fetchStats, 15000) // Refresh every 15 seconds
        return () => clearInterval(interval)
    }, [])

    const fetchStats = async () => {
        try {
            // Fetch all data in parallel
            const [workersHealth, accounts, master, warmup, health] = await Promise.all([
                fetchAllWorkersHealth(),
                fetchAllAccounts(),
                getMasterHealth(),
                getAllWarmupStatus(),
                getHealthSummary()
            ])

            // Fetch proxy stats from each worker
            const proxyStatsPromises = WORKERS.map(async (worker) => {
                try {
                    const url = window.location.hostname === 'localhost' 
                        ? `http://localhost:${worker.port}` 
                        : worker.proxyPath
                    const res = await fetch(`${url}/proxy/stats`, { signal: AbortSignal.timeout(3000) })
                    if (res.ok) {
                        const data = await res.json()
                        return { workerId: worker.id, ...data }
                    }
                } catch (e) {
                    console.error(`Failed to fetch proxy stats from ${worker.id}`)
                }
                return { workerId: worker.id, proxy: null }
            })
            const proxyResults = await Promise.all(proxyStatsPromises)
            const proxyStatsMap = {}
            proxyResults.forEach(r => { proxyStatsMap[r.workerId] = r.proxy })
            setProxyStats(proxyStatsMap)

            const activeAccounts = accounts.filter(a => a.connected && a.logged_in)
            const warmupAccountsList = accounts.filter(a => !a.warmup_complete && a.connected && a.logged_in)
            const sendingAccounts = activeAccounts // All active accounts can send

            setStats({
                totalAccounts: accounts.length,
                activeAccounts: activeAccounts.length,
                warmupAccounts: warmupAccountsList.length,
                sendingAccounts: sendingAccounts.length,
                messagesSentToday: 0,
                workers: workersHealth,
                accounts: accounts
            })
            setHealthSummary(health)
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

    // Calculate sending rate based on actual delays and limits
    const calculateSendingRate = () => {
        // Stage configuration with realistic delays
        const stageConfig = {
            'New Born': { maxDay: 5, delayMin: 30, delayMax: 60, msgsPerHour: 1 },
            'Baby': { maxDay: 15, delayMin: 20, delayMax: 40, msgsPerHour: 3 },
            'Toddler': { maxDay: 30, delayMin: 10, delayMax: 20, msgsPerHour: 6 },
            'Teen': { maxDay: 50, delayMin: 5, delayMax: 10, msgsPerHour: 10 },
            'Adult': { maxDay: 100, delayMin: 3, delayMax: 7, msgsPerHour: 20 },
            'Veteran': { maxDay: 200, delayMin: 1, delayMax: 5, msgsPerHour: 40 },
        }

        let totalMessagesPerDay = 0
        let totalMsgsPerHour = 0
        let accountBreakdown = []

        stats.accounts.forEach(account => {
            if (!account.connected || !account.logged_in) return

            let stage = 'Adult'

            if (!account.warmup_complete) {
                const ageHours = account.account_age_hours || 0
                const ageDays = ageHours / 24

                if (ageDays <= 3) {
                    stage = 'New Born'
                } else if (ageDays <= 7) {
                    stage = 'Baby'
                } else if (ageDays <= 14) {
                    stage = 'Toddler'
                } else if (ageDays <= 30) {
                    stage = 'Teen'
                }
            } else {
                // Check if veteran (60+ days)
                const ageHours = account.account_age_hours || 0
                const ageDays = ageHours / 24
                if (ageDays >= 60) {
                    stage = 'Veteran'
                }
            }

            const config = stageConfig[stage]
            totalMessagesPerDay += config.maxDay
            totalMsgsPerHour += config.msgsPerHour
            accountBreakdown.push({ 
                phone: account.phone, 
                dailyLimit: config.maxDay, 
                stage,
                msgsPerHour: config.msgsPerHour,
                delay: `${config.delayMin}-${config.delayMax}s`
            })
        })

        // Calculate based on actual throughput capacity
        const messagesPerMinute = totalMsgsPerHour / 60

        return {
            totalMessagesPerDay,
            messagesPerHour: totalMsgsPerHour,
            messagesPerMinute: messagesPerMinute.toFixed(2),
            accountBreakdown
        }
    }

    const sendingRate = calculateSendingRate()

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

            {/* Sending Rate Card - NEW! */}
            <div className="card bg-gradient-to-r from-blue-900/30 to-purple-900/30 border-blue-500/30">
                <h3 className="text-xl font-semibold text-white mb-4">📤 Sending Capacity</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="text-center">
                        <div className="text-4xl font-bold text-blue-400">{stats.sendingAccounts}</div>
                        <div className="text-sm text-gray-400">Sending Devices</div>
                    </div>
                    <div className="text-center">
                        <div className="text-4xl font-bold text-green-400">{sendingRate.messagesPerMinute}</div>
                        <div className="text-sm text-gray-400">Messages/Minute</div>
                    </div>
                    <div className="text-center">
                        <div className="text-4xl font-bold text-purple-400">{sendingRate.messagesPerHour}</div>
                        <div className="text-sm text-gray-400">Messages/Hour</div>
                    </div>
                    <div className="text-center">
                        <div className="text-4xl font-bold text-yellow-400">{sendingRate.totalMessagesPerDay}</div>
                        <div className="text-sm text-gray-400">Max/Day</div>
                    </div>
                </div>
                
                {/* Breakdown by stage */}
                <div className="mt-6 pt-4 border-t border-wa-border">
                    <h4 className="text-sm font-medium text-gray-400 mb-3">Breakdown by Stage (with delays)</h4>
                    <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                        {[
                            { stage: 'New Born', emoji: '🐣', limit: 5, rate: 1, delay: '30-60s' },
                            { stage: 'Baby', emoji: '👶', limit: 15, rate: 3, delay: '20-40s' },
                            { stage: 'Toddler', emoji: '🧒', limit: 30, rate: 6, delay: '10-20s' },
                            { stage: 'Teen', emoji: '👦', limit: 50, rate: 10, delay: '5-10s' },
                            { stage: 'Adult', emoji: '🧑', limit: 100, rate: 20, delay: '3-7s' },
                            { stage: 'Veteran', emoji: '🎖️', limit: 200, rate: 40, delay: '1-5s' },
                        ].map(({ stage, emoji, limit, rate, delay }) => {
                            const count = sendingRate.accountBreakdown.filter(a => a.stage === stage).length
                            return (
                                <div key={stage} className={`bg-wa-bg rounded-lg p-3 text-center ${count > 0 ? 'ring-1 ring-wa-green/50' : ''}`}>
                                    <div className="text-lg">{emoji}</div>
                                    <div className="text-xl font-bold text-white">{count}</div>
                                    <div className="text-xs text-gray-500">{stage}</div>
                                    <div className="text-xs text-green-400">{limit}/day</div>
                                    <div className="text-xs text-blue-400">{rate}/hr</div>
                                    <div className="text-xs text-gray-600">{delay}</div>
                                </div>
                            )
                        })}
                    </div>
                </div>
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
                    title="Sending"
                    value={stats.sendingAccounts}
                    icon="📤"
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

            {/* Workers & Proxy Status */}
            <div className="card">
                <h3 className="text-xl font-semibold text-white mb-6">🌐 Workers & Proxy Status</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {stats.workers.map((worker) => (
                        <WorkerCard 
                            key={worker.id} 
                            worker={worker} 
                            proxyStats={proxyStats[worker.id]}
                            accounts={stats.accounts.filter(a => a.workerId === worker.id)}
                        />
                    ))}
                </div>
            </div>

            {/* Account Health Summary */}
            {healthSummary && (
                <div className="card">
                    <h3 className="text-xl font-semibold text-white mb-6">🛡️ Account Health</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 text-center">
                            <div className="text-2xl font-bold text-green-400">{healthSummary.healthy_accounts || 0}</div>
                            <div className="text-sm text-gray-400">Healthy (80+)</div>
                        </div>
                        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-center">
                            <div className="text-2xl font-bold text-yellow-400">{healthSummary.warning_accounts || 0}</div>
                            <div className="text-sm text-gray-400">Warning (60-79)</div>
                        </div>
                        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-center">
                            <div className="text-2xl font-bold text-red-400">{healthSummary.critical_accounts || 0}</div>
                            <div className="text-sm text-gray-400">Critical (&lt;60)</div>
                        </div>
                        <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4 text-center">
                            <div className="text-2xl font-bold text-purple-400">
                                {Math.round(healthSummary.avg_safety_score || 0)}%
                            </div>
                            <div className="text-sm text-gray-400">Avg Score</div>
                        </div>
                    </div>
                    {healthSummary.suspicious_accounts > 0 && (
                        <div className="mt-4 p-3 bg-red-500/20 border border-red-500/30 rounded-lg flex items-center gap-2">
                            <span className="text-red-400">⚠️</span>
                            <span className="text-red-400 text-sm">
                                {healthSummary.suspicious_accounts} suspicious account(s) detected
                            </span>
                        </div>
                    )}
                </div>
            )}

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

function WorkerCard({ worker, proxyStats, accounts }) {
    const isOnline = worker.status === 'online'
    const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }
    
    const activeAccounts = accounts?.filter(a => a.connected && a.logged_in).length || 0
    const totalProxies = proxyStats?.total_proxies || 0
    const assignedProxies = proxyStats?.total_assignments || 0

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
            
            {/* Stats */}
            <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="bg-wa-card rounded-lg p-2 text-center">
                    <div className="text-lg font-bold text-blue-400">{activeAccounts}</div>
                    <div className="text-xs text-gray-500">Accounts</div>
                </div>
                <div className="bg-wa-card rounded-lg p-2 text-center">
                    <div className="text-lg font-bold text-purple-400">{totalProxies}</div>
                    <div className="text-xs text-gray-500">Proxies</div>
                </div>
            </div>
            
            {/* Proxy Info */}
            <div className="text-xs text-gray-500 space-y-1">
                <div className="flex justify-between">
                    <span>Proxy Mode:</span>
                    <span className="text-green-400">{proxyStats?.mode || 'Sticky'}</span>
                </div>
                <div className="flex justify-between">
                    <span>Assigned:</span>
                    <span className="text-white">{assignedProxies} / {totalProxies}</span>
                </div>
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
