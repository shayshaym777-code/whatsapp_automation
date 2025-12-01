import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
    WORKERS,
    fetchAllWorkersHealth,
    fetchAllAccounts,
    getMasterHealth
} from '../api/workers'

// v8.0: Simplified Dashboard
// Rate: 20-25 messages/minute per device
// Delay: 2-4 seconds between messages
// Pauses: every 10/50/100 messages

function Dashboard() {
    const [stats, setStats] = useState({
        totalAccounts: 0,
        connectedAccounts: 0,
        disconnectedAccounts: 0,
        incompleteAccounts: 0,
        workers: [],
        accounts: []
    })
    const [masterHealth, setMasterHealth] = useState(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetchStats()
        const interval = setInterval(fetchStats, 15000) // Refresh every 15 seconds
        return () => clearInterval(interval)
    }, [])

    const fetchStats = async () => {
        try {
            const [workersHealth, accounts, master] = await Promise.all([
                fetchAllWorkersHealth(),
                fetchAllAccounts(),
                getMasterHealth()
            ])

            const connectedAccounts = accounts.filter(a => a.connected && a.logged_in)
            const disconnectedAccounts = accounts.filter(a => !a.connected || !a.logged_in)
            const incompleteAccounts = accounts.filter(a => {
                const total = a.sessions_total || 1
                return total < 4
            })

            setStats({
                totalAccounts: accounts.length,
                connectedAccounts: connectedAccounts.length,
                disconnectedAccounts: disconnectedAccounts.length,
                incompleteAccounts: incompleteAccounts.length,
                workers: workersHealth,
                accounts: accounts
            })
            setMasterHealth(master)
            setLoading(false)
        } catch (err) {
            console.error('Failed to fetch stats:', err)
            setLoading(false)
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
                    <p className="text-gray-400">System overview - v8.0</p>
                </div>
                <Link to="/accounts/add" className="btn-primary flex items-center gap-2">
                    ➕ Add Account
                </Link>
            </div>

            {/* Sending Rate Card - MAIN FEATURE */}
            <div className="card bg-gradient-to-r from-green-900/30 to-blue-900/30 border-green-500/30">
                <h3 className="text-xl font-semibold text-white mb-4">📤 קצב שליחה</h3>
                
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                    <div className="text-center bg-wa-bg rounded-lg p-4">
                        <div className="text-4xl font-bold text-green-400">{stats.connectedAccounts}</div>
                        <div className="text-sm text-gray-400">מכשירים מחוברים</div>
                    </div>
                    <div className="text-center bg-wa-bg rounded-lg p-4">
                        <div className="text-4xl font-bold text-blue-400">20-25</div>
                        <div className="text-sm text-gray-400">הודעות/דקה למכשיר</div>
                    </div>
                    <div className="text-center bg-wa-bg rounded-lg p-4">
                        <div className="text-4xl font-bold text-purple-400">2-4</div>
                        <div className="text-sm text-gray-400">שניות delay</div>
                    </div>
                    <div className="text-center bg-wa-bg rounded-lg p-4">
                        <div className="text-4xl font-bold text-yellow-400">
                            {stats.connectedAccounts * 22}
                        </div>
                        <div className="text-sm text-gray-400">סה"כ הודעות/דקה</div>
                    </div>
                </div>

                {/* Anti-Ban Info */}
                <div className="bg-wa-bg rounded-lg p-4">
                    <h4 className="text-sm font-medium text-gray-400 mb-3">🛡️ Anti-Ban Settings</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                        <div className="flex justify-between">
                            <span className="text-gray-500">Delay:</span>
                            <span className="text-white">2-4 sec + jitter</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-500">כל 10 הודעות:</span>
                            <span className="text-yellow-400">10-30 sec</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-500">כל 50 הודעות:</span>
                            <span className="text-orange-400">2-5 min</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-gray-500">כל 100 הודעות:</span>
                            <span className="text-red-400">5-10 min</span>
                        </div>
                    </div>
                </div>

                {/* Example calculation */}
                <div className="mt-4 text-sm text-gray-500">
                    <p>
                        💡 עם {stats.connectedAccounts} מכשירים: 
                        <span className="text-green-400 font-bold"> ~{stats.connectedAccounts * 22} הודעות/דקה</span> = 
                        <span className="text-blue-400 font-bold"> ~{stats.connectedAccounts * 1320} הודעות/שעה</span>
                    </p>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard
                    title="Total Accounts"
                    value={stats.totalAccounts}
                    icon="📱"
                    color="blue"
                />
                <StatCard
                    title="Connected"
                    value={stats.connectedAccounts}
                    icon="🟢"
                    color="green"
                />
                <StatCard
                    title="Disconnected"
                    value={stats.disconnectedAccounts}
                    icon="🔴"
                    color="red"
                />
                <StatCard
                    title="Need Sessions"
                    value={stats.incompleteAccounts}
                    icon="⚠️"
                    color="yellow"
                    subtitle="< 4 sessions"
                />
            </div>

            {/* Warnings */}
            {stats.disconnectedAccounts > 0 && (
                <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 flex items-center gap-3">
                    <span className="text-3xl">🔴</span>
                    <div>
                        <h4 className="font-semibold text-red-400">
                            {stats.disconnectedAccounts} מכשירים מנותקים!
                        </h4>
                        <p className="text-gray-400 text-sm">
                            צריך לסרוק QR מחדש.
                        </p>
                    </div>
                    <Link to="/accounts" className="btn-secondary ml-auto">
                        View →
                    </Link>
                </div>
            )}

            {stats.incompleteAccounts > 0 && (
                <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-4 flex items-center gap-3">
                    <span className="text-3xl">⚠️</span>
                    <div>
                        <h4 className="font-semibold text-yellow-400">
                            {stats.incompleteAccounts} מכשירים צריכים עוד sessions!
                        </h4>
                        <p className="text-gray-400 text-sm">
                            כל מכשיר צריך 4 sessions לגיבוי.
                        </p>
                    </div>
                    <Link to="/accounts?filter=incomplete" className="btn-secondary ml-auto">
                        View →
                    </Link>
                </div>
            )}

            {/* Workers Status */}
            <div className="card">
                <h3 className="text-xl font-semibold text-white mb-6">🖥️ Workers</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {stats.workers.map((worker) => (
                        <WorkerCard 
                            key={worker.id} 
                            worker={worker} 
                            accounts={stats.accounts.filter(a => a.workerId === worker.id)}
                        />
                    ))}
                </div>
            </div>

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
        red: 'from-red-500/20 to-red-600/10 border-red-500/30',
        yellow: 'from-yellow-500/20 to-yellow-600/10 border-yellow-500/30',
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

function WorkerCard({ worker, accounts }) {
    const isOnline = worker.status === 'online'
    const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }
    
    const connectedAccounts = accounts?.filter(a => a.connected && a.logged_in).length || 0
    const totalAccounts = accounts?.length || 0

    return (
        <div className={`bg-wa-bg border rounded-xl p-5 transition-all duration-300 ${
            isOnline ? 'border-green-500/30' : 'border-red-500/30'
        }`}>
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <span className="text-2xl">{countryFlags[worker.country] || '🌍'}</span>
                    <div>
                        <h4 className="font-semibold text-white">{worker.name}</h4>
                        <p className="text-xs text-gray-500">Port {worker.port}</p>
                    </div>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                    isOnline ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                }`}>
                    {isOnline ? 'Online' : 'Offline'}
                </span>
            </div>
            
            <div className="grid grid-cols-2 gap-2">
                <div className="bg-wa-card rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-green-400">{connectedAccounts}</div>
                    <div className="text-xs text-gray-500">Connected</div>
                </div>
                <div className="bg-wa-card rounded-lg p-3 text-center">
                    <div className="text-xl font-bold text-blue-400">{totalAccounts}</div>
                    <div className="text-xs text-gray-500">Total</div>
                </div>
            </div>
        </div>
    )
}

function HealthItem({ name, status, detail }) {
    const isOnline = status === 'online'

    return (
        <div className="flex items-center justify-between py-3 border-b border-wa-border last:border-0">
            <div className="flex items-center gap-3">
                <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}></div>
                <span className="text-white">{name}</span>
            </div>
            <div className="flex items-center gap-4">
                <span className="text-gray-500 text-sm">{detail}</span>
                <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                    isOnline ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
                }`}>
                    {isOnline ? 'Healthy' : 'Down'}
                </span>
            </div>
        </div>
    )
}

export default Dashboard
