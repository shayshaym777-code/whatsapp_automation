import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { WORKERS, fetchWorkerAccounts, disconnectAccount, detectCountry } from '../api/workers'
import AccountCard from '../components/AccountCard'

function Accounts() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadAccounts()
    const interval = setInterval(loadAccounts, 5000) // Refresh every 5s
    return () => clearInterval(interval)
  }, [])

  async function loadAccounts() {
    try {
      setError(null)
      const allAccounts = []
      
      await Promise.all(
        WORKERS.map(async (worker) => {
          const workerAccounts = await fetchWorkerAccounts(worker)
          workerAccounts.forEach(acc => {
            allAccounts.push({
              ...acc,
              worker: worker,
              country: detectCountry(acc.phone),
            })
          })
        })
      )
      
      setAccounts(allAccounts)
    } catch (err) {
      setError('Failed to load accounts')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function handleDisconnect(account) {
    if (!confirm(`Disconnect ${account.phone}?`)) return
    
    try {
      await disconnectAccount(account.worker, account.phone)
      loadAccounts()
    } catch (err) {
      alert('Failed to disconnect: ' + err.message)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-wa-green"></div>
      </div>
    )
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Accounts</h1>
          <p className="text-dark-400">Manage your connected WhatsApp accounts</p>
        </div>
        <Link to="/accounts/add" className="btn-primary flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Account
        </Link>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
          {error}
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="card text-center py-12">
          <div className="w-16 h-16 bg-dark-700 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-dark-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No accounts connected</h3>
          <p className="text-dark-400 mb-4">Get started by adding your first WhatsApp account</p>
          <Link to="/accounts/add" className="btn-primary">
            Add Your First Account
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {accounts.map((account) => (
            <AccountCard 
              key={`${account.worker.id}-${account.phone}`}
              account={account}
              onDisconnect={() => handleDisconnect(account)}
              onRefresh={loadAccounts}
            />
          ))}
        </div>
      )}

      {/* Summary */}
      {accounts.length > 0 && (
        <div className="mt-8 card">
          <h3 className="text-lg font-semibold text-white mb-4">Summary</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-dark-400 text-sm">Total</p>
              <p className="text-2xl font-bold text-white">{accounts.length}</p>
            </div>
            <div>
              <p className="text-dark-400 text-sm">Connected</p>
              <p className="text-2xl font-bold text-yellow-400">
                {accounts.filter(a => a.connected).length}
              </p>
            </div>
            <div>
              <p className="text-dark-400 text-sm">Logged In</p>
              <p className="text-2xl font-bold text-green-400">
                {accounts.filter(a => a.logged_in).length}
              </p>
            </div>
            <div>
              <p className="text-dark-400 text-sm">Pending</p>
              <p className="text-2xl font-bold text-blue-400">
                {accounts.filter(a => a.pending_qr).length}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Accounts

