import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

const WORKERS = [
  { id: 'worker-1', name: 'Worker 1', country: 'US', port: 3001 },
  { id: 'worker-2', name: 'Worker 2', country: 'IL', port: 3002 },
  { id: 'worker-3', name: 'Worker 3', country: 'GB', port: 3003 },
]

function Accounts() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchAccounts()
  }, [])

  const fetchAccounts = async () => {
    setLoading(true)
    try {
      const allAccounts = []
      
      for (const worker of WORKERS) {
        try {
          const res = await fetch(`http://localhost:${worker.port}/accounts`)
          if (res.ok) {
            const data = await res.json()
            const workerAccounts = (data.accounts || []).map(acc => ({
              ...acc,
              worker: worker.name,
              workerId: worker.id,
              workerPort: worker.port,
              workerCountry: worker.country
            }))
            allAccounts.push(...workerAccounts)
          }
        } catch (e) {
          console.log(`Worker ${worker.id} not available`)
        }
      }
      
      setAccounts(allAccounts)
      setLoading(false)
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const disconnectAccount = async (account) => {
    if (!confirm(`Disconnect ${account.phone}?`)) return
    
    try {
      const res = await fetch(`http://localhost:${account.workerPort}/accounts/${encodeURIComponent(account.phone)}/disconnect`, {
        method: 'POST'
      })
      if (res.ok) {
        fetchAccounts()
      }
    } catch (err) {
      alert('Failed to disconnect: ' + err.message)
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
          <h2 className="text-3xl font-bold text-white mb-2">Accounts</h2>
          <p className="text-gray-400">Manage connected WhatsApp accounts</p>
        </div>
        <Link to="/accounts/add" className="btn-primary flex items-center gap-2">
          <span>+</span>
          Add Account
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card text-center">
          <div className="text-3xl font-bold text-white">{accounts.length}</div>
          <div className="text-gray-400 text-sm">Total Accounts</div>
        </div>
        <div className="card text-center">
          <div className="text-3xl font-bold text-green-400">
            {accounts.filter(a => a.connected).length}
          </div>
          <div className="text-gray-400 text-sm">Connected</div>
        </div>
        <div className="card text-center">
          <div className="text-3xl font-bold text-yellow-400">
            {accounts.filter(a => !a.connected).length}
          </div>
          <div className="text-gray-400 text-sm">Disconnected</div>
        </div>
      </div>

      {/* Accounts List */}
      {accounts.length === 0 ? (
        <div className="card text-center py-12">
          <div className="text-6xl mb-4">📱</div>
          <h3 className="text-xl font-semibold text-white mb-2">No accounts connected</h3>
          <p className="text-gray-400 mb-6">Add your first WhatsApp account to get started</p>
          <Link to="/accounts/add" className="btn-primary inline-block">
            Add Account
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts.map((account, index) => (
            <AccountCard 
              key={account.phone || index} 
              account={account} 
              onDisconnect={() => disconnectAccount(account)}
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

  return (
    <div className={`card transition-all duration-300 ${
      isConnected ? 'border-green-500/30' : 'border-yellow-500/30'
    }`}>
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center text-xl ${
            isConnected ? 'bg-green-500/20' : 'bg-yellow-500/20'
          }`}>
            {countryFlags[account.workerCountry] || '📱'}
          </div>
          <div>
            <h4 className="font-semibold text-white">{account.phone}</h4>
            <p className="text-xs text-gray-500">{account.worker}</p>
          </div>
        </div>
        <span className={`badge ${isConnected ? 'badge-success' : 'badge-warning'}`}>
          {isConnected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      <div className="space-y-2 mb-4">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Logged In</span>
          <span className={isLoggedIn ? 'text-green-400' : 'text-red-400'}>
            {isLoggedIn ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Device ID</span>
          <span className="text-gray-300 font-mono text-xs">
            {account.device_id?.slice(0, 12) || 'N/A'}...
          </span>
        </div>
      </div>

      <div className="flex gap-2">
        <button 
          onClick={onDisconnect}
          className="flex-1 py-2 px-3 bg-red-500/20 text-red-400 rounded-lg text-sm font-medium
                     hover:bg-red-500/30 transition-colors"
        >
          Disconnect
        </button>
      </div>
    </div>
  )
}

export default Accounts

