import { useState } from 'react'

function AccountCard({ account, onDisconnect, onRefresh }) {
  const [showDetails, setShowDetails] = useState(false)

  const getStatusBadge = () => {
    if (account.logged_in) {
      return <span className="badge-success">Logged In</span>
    }
    if (account.pending_qr) {
      return <span className="badge-warning">Pending QR</span>
    }
    if (account.connected) {
      return <span className="badge-info">Connected</span>
    }
    return <span className="badge-error">Disconnected</span>
  }

  return (
    <div className="card hover:border-dark-600 transition-all duration-200">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-12 h-12 bg-dark-700 rounded-full flex items-center justify-center text-2xl">
              {account.country.flag}
            </div>
            {account.logged_in && (
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-dark-800"></div>
            )}
          </div>
          <div>
            <h3 className="font-semibold text-white font-mono">{account.phone}</h3>
            <p className="text-xs text-dark-400">{account.country.name}</p>
          </div>
        </div>
        {getStatusBadge()}
      </div>

      {/* Worker Info */}
      <div className="p-3 bg-dark-700/50 rounded-lg mb-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-dark-400">Worker</span>
          <span className="text-white">{account.worker.name}</span>
        </div>
        <div className="flex items-center justify-between text-sm mt-1">
          <span className="text-dark-400">Country</span>
          <span className="text-white">{account.worker.country}</span>
        </div>
      </div>

      {/* Status Details */}
      <div className="space-y-2 text-sm mb-4">
        <div className="flex items-center justify-between">
          <span className="text-dark-400">Connected</span>
          <span className={account.connected ? 'text-green-400' : 'text-red-400'}>
            {account.connected ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-dark-400">Logged In</span>
          <span className={account.logged_in ? 'text-green-400' : 'text-red-400'}>
            {account.logged_in ? 'Yes' : 'No'}
          </span>
        </div>
        {account.device_id && (
          <div className="flex items-center justify-between">
            <span className="text-dark-400">Device ID</span>
            <span className="text-dark-300 font-mono text-xs truncate max-w-[150px]">
              {account.device_id}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={onRefresh}
          className="btn-secondary flex-1 py-2 text-sm"
        >
          <svg className="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Refresh
        </button>
        <button
          onClick={onDisconnect}
          className="btn-danger flex-1 py-2 text-sm"
        >
          <svg className="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
          Disconnect
        </button>
      </div>
    </div>
  )
}

export default AccountCard

