import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { WORKERS, fetchWorkerHealth, fetchWorkerAccounts } from '../api/workers'

function Dashboard() {
  const [workers, setWorkers] = useState([])
  const [stats, setStats] = useState({
    totalAccounts: 0,
    connectedAccounts: 0,
    loggedInAccounts: 0,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDashboardData()
    const interval = setInterval(loadDashboardData, 10000) // Refresh every 10s
    return () => clearInterval(interval)
  }, [])

  async function loadDashboardData() {
    try {
      const workerData = await Promise.all(
        WORKERS.map(async (worker) => {
          const health = await fetchWorkerHealth(worker)
          const accounts = await fetchWorkerAccounts(worker)
          return {
            ...worker,
            health,
            accounts,
            online: health !== null,
          }
        })
      )
      
      setWorkers(workerData)
      
      // Calculate stats
      let total = 0, connected = 0, loggedIn = 0
      workerData.forEach(w => {
        w.accounts.forEach(acc => {
          total++
          if (acc.connected) connected++
          if (acc.logged_in) loggedIn++
        })
      })
      
      setStats({
        totalAccounts: total,
        connectedAccounts: connected,
        loggedInAccounts: loggedIn,
      })
    } catch (error) {
      console.error('Failed to load dashboard data:', error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Dashboard</h1>
        <p className="text-dark-400">Overview of your WhatsApp automation system</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-dark-400 text-sm">Total Accounts</p>
              <p className="text-3xl font-bold text-white mt-1">{stats.totalAccounts}</p>
            </div>
            <div className="w-12 h-12 bg-blue-500/20 rounded-xl flex items-center justify-center">
              <svg className="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-dark-400 text-sm">Connected</p>
              <p className="text-3xl font-bold text-white mt-1">{stats.connectedAccounts}</p>
            </div>
            <div className="w-12 h-12 bg-yellow-500/20 rounded-xl flex items-center justify-center">
              <svg className="w-6 h-6 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-dark-400 text-sm">Logged In</p>
              <p className="text-3xl font-bold text-white mt-1">{stats.loggedInAccounts}</p>
            </div>
            <div className="w-12 h-12 bg-green-500/20 rounded-xl flex items-center justify-center">
              <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-dark-400 text-sm">Active Workers</p>
              <p className="text-3xl font-bold text-white mt-1">
                {workers.filter(w => w.online).length}/{WORKERS.length}
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-500/20 rounded-xl flex items-center justify-center">
              <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Workers Grid */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold text-white mb-4">Workers Status</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {workers.map((worker) => (
            <div key={worker.id} className="card">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${worker.online ? 'bg-green-500' : 'bg-red-500'}`}>
                    {worker.online && (
                      <span className="absolute w-3 h-3 rounded-full bg-green-500 animate-ping opacity-75"></span>
                    )}
                  </div>
                  <div>
                    <h3 className="font-semibold text-white">{worker.name}</h3>
                    <p className="text-xs text-dark-400">Port {worker.port}</p>
                  </div>
                </div>
                <span className="text-2xl">{worker.country === 'US' ? '🇺🇸' : worker.country === 'IL' ? '🇮🇱' : '🇬🇧'}</span>
              </div>
              
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-dark-400">Country</span>
                  <span className="text-white">{worker.country}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-dark-400">Accounts</span>
                  <span className="text-white">{worker.accounts.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-dark-400">Status</span>
                  <span className={worker.online ? 'badge-success' : 'badge-error'}>
                    {worker.online ? 'Online' : 'Offline'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-xl font-semibold text-white mb-4">Quick Actions</h2>
        <div className="flex gap-4">
          <Link to="/accounts/add" className="btn-primary flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add Account
          </Link>
          <Link to="/send" className="btn-secondary flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
            Send Message
          </Link>
          <button onClick={loadDashboardData} className="btn-secondary flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>
    </div>
  )
}

export default Dashboard

