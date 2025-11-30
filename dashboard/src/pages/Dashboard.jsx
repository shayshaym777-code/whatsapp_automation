import { useState, useEffect } from 'react'

const WORKERS = [
  { id: 'worker-1', name: 'Worker 1', country: 'US', port: 3001 },
  { id: 'worker-2', name: 'Worker 2', country: 'IL', port: 3002 },
  { id: 'worker-3', name: 'Worker 3', country: 'GB', port: 3003 },
]

function Dashboard() {
  const [stats, setStats] = useState({
    totalAccounts: 0,
    activeAccounts: 0,
    messagesSentToday: 0,
    workers: []
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchStats()
    const interval = setInterval(fetchStats, 10000) // Refresh every 10 seconds
    return () => clearInterval(interval)
  }, [])

  const fetchStats = async () => {
    try {
      // Fetch from all workers
      const workerStats = await Promise.all(
        WORKERS.map(async (worker) => {
          try {
            const [healthRes, accountsRes] = await Promise.all([
              fetch(`http://localhost:${worker.port}/health`).catch(() => null),
              fetch(`http://localhost:${worker.port}/accounts`).catch(() => null)
            ])
            
            const health = healthRes?.ok ? await healthRes.json() : null
            const accounts = accountsRes?.ok ? await accountsRes.json() : { accounts: [] }
            
            return {
              ...worker,
              status: health ? 'online' : 'offline',
              accounts: accounts.accounts || [],
              accountCount: accounts.accounts?.length || 0
            }
          } catch (e) {
            return { ...worker, status: 'offline', accounts: [], accountCount: 0 }
          }
        })
      )

      const totalAccounts = workerStats.reduce((sum, w) => sum + w.accountCount, 0)
      const activeAccounts = workerStats.reduce((sum, w) => 
        sum + (w.accounts?.filter(a => a.connected)?.length || 0), 0)

      setStats({
        totalAccounts,
        activeAccounts,
        messagesSentToday: 0, // TODO: Get from master server
        workers: workerStats
      })
      setLoading(false)
    } catch (err) {
      setError(err.message)
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
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">Dashboard</h2>
        <p className="text-gray-400">System overview and statistics</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <StatCard 
          title="Total Accounts" 
          value={stats.totalAccounts}
          icon="👥"
          color="green"
        />
        <StatCard 
          title="Active Accounts" 
          value={stats.activeAccounts}
          icon="✅"
          color="blue"
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

      {/* Recent Activity */}
      <div className="card">
        <h3 className="text-xl font-semibold text-white mb-6">System Health</h3>
        <div className="space-y-4">
          <HealthItem 
            name="Master Server" 
            status="online" 
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
  }

  return (
    <div className={`bg-gradient-to-br ${colorClasses[color]} border rounded-xl p-6`}>
      <div className="flex items-center justify-between mb-4">
        <span className="text-2xl">{icon}</span>
      </div>
      <div className="text-3xl font-bold text-white mb-1">
        {value}
        {subtitle && <span className="text-lg text-gray-400 font-normal ml-1">{subtitle}</span>}
      </div>
      <div className="text-gray-400 text-sm">{title}</div>
    </div>
  )
}

function WorkerCard({ worker }) {
  const isOnline = worker.status === 'online'
  const countryFlags = { US: '🇺🇸', IL: '🇮🇱', GB: '🇬🇧' }

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
        <span className={`badge ${isOnline ? 'badge-success' : 'badge-error'}`}>
          {isOnline ? 'Online' : 'Offline'}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-400">Accounts</span>
        <span className="text-white font-medium">{worker.accountCount}</span>
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

