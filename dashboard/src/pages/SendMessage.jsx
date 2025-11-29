import { useState, useEffect } from 'react'
import { WORKERS, fetchWorkerAccounts, sendMessage, detectCountry, getWorkerForPhone } from '../api/workers'

function SendMessage() {
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState('')
  const [toPhone, setToPhone] = useState('+')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadAccounts()
  }, [])

  async function loadAccounts() {
    const allAccounts = []
    await Promise.all(
      WORKERS.map(async (worker) => {
        const workerAccounts = await fetchWorkerAccounts(worker)
        workerAccounts.forEach(acc => {
          if (acc.logged_in) {
            allAccounts.push({
              ...acc,
              worker: worker,
              country: detectCountry(acc.phone),
            })
          }
        })
      })
    )
    setAccounts(allAccounts)
    if (allAccounts.length > 0) {
      setSelectedAccount(allAccounts[0].phone)
    }
  }

  function handleToPhoneChange(e) {
    let value = e.target.value
    if (!value.startsWith('+')) {
      value = '+' + value.replace(/[^0-9]/g, '')
    } else {
      value = '+' + value.slice(1).replace(/[^0-9]/g, '')
    }
    setToPhone(value)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    
    if (!selectedAccount) {
      setError('Please select a sender account')
      return
    }
    if (toPhone.length < 8) {
      setError('Please enter a valid recipient phone number')
      return
    }
    if (!message.trim()) {
      setError('Please enter a message')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const account = accounts.find(a => a.phone === selectedAccount)
      const response = await sendMessage(account.worker, selectedAccount, toPhone, message)
      setResult(response)
      setMessage('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const toCountry = detectCountry(toPhone)

  return (
    <div className="animate-fade-in max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Send Message</h1>
        <p className="text-dark-400">Send a WhatsApp message from a connected account</p>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* From Account */}
          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              From Account
            </label>
            {accounts.length === 0 ? (
              <div className="p-4 bg-yellow-500/20 border border-yellow-500/30 rounded-lg text-yellow-400">
                No logged-in accounts available. Please connect an account first.
              </div>
            ) : (
              <select
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                className="input"
                disabled={loading}
              >
                {accounts.map((acc) => (
                  <option key={acc.phone} value={acc.phone}>
                    {acc.country.flag} {acc.phone} ({acc.worker.name})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* To Phone */}
          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              To Phone Number
            </label>
            <div className="relative">
              <input
                type="tel"
                value={toPhone}
                onChange={handleToPhoneChange}
                placeholder="+1234567890"
                className="input font-mono pl-16"
                disabled={loading}
              />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl">
                {toCountry.flag}
              </span>
            </div>
          </div>

          {/* Message */}
          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Message
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Type your message here..."
              rows={4}
              className="input resize-none"
              disabled={loading}
            />
            <p className="mt-1 text-sm text-dark-500">{message.length} characters</p>
          </div>

          {/* Error */}
          {error && (
            <div className="p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
              {error}
            </div>
          )}

          {/* Success */}
          {result && (
            <div className="p-4 bg-green-500/20 border border-green-500/30 rounded-lg">
              <div className="flex items-center gap-2 text-green-400 mb-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Message sent successfully!
              </div>
              <p className="text-sm text-dark-400">
                Message ID: <span className="font-mono text-dark-300">{result.message_id}</span>
              </p>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading || accounts.length === 0 || !message.trim()}
            className="btn-primary w-full py-3 text-lg flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Sending...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
                Send Message
              </>
            )}
          </button>
        </form>
      </div>

      {/* Tips */}
      <div className="mt-6 card bg-dark-800/30">
        <h3 className="text-lg font-semibold text-white mb-3">Tips</h3>
        <ul className="space-y-2 text-sm text-dark-400">
          <li className="flex items-start gap-2">
            <span className="text-wa-green">•</span>
            Messages are subject to anti-ban delays (1-7 seconds between messages)
          </li>
          <li className="flex items-start gap-2">
            <span className="text-wa-green">•</span>
            Maximum 100 messages per account per day
          </li>
          <li className="flex items-start gap-2">
            <span className="text-wa-green">•</span>
            For bulk sending, use the Master API at /api/messages/bulk-send
          </li>
        </ul>
      </div>
    </div>
  )
}

export default SendMessage

