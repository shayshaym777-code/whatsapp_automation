import { useState, useEffect } from 'react'

const WORKERS = [
  { id: 'worker-1', name: 'Worker 1 (US)', country: 'US', port: 3001, flag: '🇺🇸' },
  { id: 'worker-2', name: 'Worker 2 (Israel)', country: 'IL', port: 3002, flag: '🇮🇱' },
  { id: 'worker-3', name: 'Worker 3 (UK)', country: 'GB', port: 3003, flag: '🇬🇧' },
]

function SendMessage() {
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [toPhone, setToPhone] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    fetchAccounts()
  }, [])

  const fetchAccounts = async () => {
    const allAccounts = []
    
    for (const worker of WORKERS) {
      try {
        const res = await fetch(`http://localhost:${worker.port}/accounts`)
        if (res.ok) {
          const data = await res.json()
          const workerAccounts = (data.accounts || [])
            .filter(acc => acc.connected && acc.logged_in)
            .map(acc => ({
              ...acc,
              worker: worker.name,
              workerId: worker.id,
              workerPort: worker.port,
              workerCountry: worker.country,
              workerFlag: worker.flag
            }))
          allAccounts.push(...workerAccounts)
        }
      } catch (e) {
        console.log(`Worker ${worker.id} not available`)
      }
    }
    
    setAccounts(allAccounts)
    if (allAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(allAccounts[0])
    }
  }

  const sendMessage = async () => {
    if (!selectedAccount) {
      setError('Please select an account')
      return
    }
    if (!toPhone) {
      setError('Please enter recipient phone number')
      return
    }
    if (!message) {
      setError('Please enter a message')
      return
    }

    // Clean phone number
    let cleanToPhone = toPhone.replace(/\s/g, '')
    if (!cleanToPhone.startsWith('+')) {
      cleanToPhone = '+' + cleanToPhone
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const res = await fetch(`http://localhost:${selectedAccount.workerPort}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_phone: selectedAccount.phone,
          to_phone: cleanToPhone,
          message: message
        })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to send message')
      }

      setResult({
        success: true,
        messageId: data.message_id,
        timestamp: new Date().toLocaleTimeString()
      })
      setMessage('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">Send Message</h2>
        <p className="text-gray-400">Send a WhatsApp message from a connected account</p>
      </div>

      {/* Form */}
      <div className="card">
        {/* From Account */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            From Account
          </label>
          {accounts.length === 0 ? (
            <div className="p-4 bg-yellow-500/20 border border-yellow-500/30 rounded-lg text-yellow-400 text-sm">
              No connected accounts available. Please add an account first.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {accounts.map((account) => (
                <button
                  key={account.phone}
                  onClick={() => setSelectedAccount(account)}
                  className={`p-4 rounded-xl border text-left transition-all duration-200 ${
                    selectedAccount?.phone === account.phone
                      ? 'bg-wa-green/20 border-wa-green'
                      : 'bg-wa-bg border-wa-border hover:border-wa-green/50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{account.workerFlag}</span>
                    <div>
                      <div className="text-white font-medium">{account.phone}</div>
                      <div className="text-xs text-gray-500">{account.worker}</div>
                    </div>
                    {selectedAccount?.phone === account.phone && (
                      <span className="ml-auto text-wa-green">✓</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* To Phone */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            To Phone Number
          </label>
          <input
            type="tel"
            value={toPhone}
            onChange={(e) => setToPhone(e.target.value)}
            placeholder="+972501234567"
            className="input"
          />
        </div>

        {/* Message */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-3">
            Message
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message here..."
            rows={4}
            className="input resize-none"
          />
          <p className="text-xs text-gray-500 mt-2">
            {message.length} characters
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
            {error}
          </div>
        )}

        {/* Success */}
        {result?.success && (
          <div className="mb-6 p-4 bg-green-500/20 border border-green-500/30 rounded-lg">
            <div className="flex items-center gap-2 text-green-400">
              <span>✅</span>
              <span>Message sent successfully!</span>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Message ID: {result.messageId} • {result.timestamp}
            </p>
          </div>
        )}

        {/* Send Button */}
        <button
          onClick={sendMessage}
          disabled={loading || accounts.length === 0}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Sending...
            </>
          ) : (
            <>
              <span>📤</span>
              Send Message
            </>
          )}
        </button>
      </div>

      {/* Quick Templates */}
      <div className="card">
        <h3 className="text-lg font-semibold text-white mb-4">📝 Quick Templates</h3>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Hello', text: 'היי, מה שלומך?' },
            { label: 'Thanks', text: 'תודה רבה! 🙏' },
            { label: 'OK', text: 'בסדר, מקובל עליי' },
            { label: 'Later', text: 'אחזור אליך בהמשך' },
          ].map((template) => (
            <button
              key={template.label}
              onClick={() => setMessage(template.text)}
              className="p-3 bg-wa-bg border border-wa-border rounded-lg text-sm text-gray-300
                         hover:border-wa-green/50 hover:text-white transition-all duration-200"
            >
              {template.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default SendMessage

