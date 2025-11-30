import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
    WORKERS,
    fetchAllAccounts,
    sendMessage,
    sendBulkMessages
} from '../api/workers'

function SendMessage() {
    const [searchParams] = useSearchParams()
    const [accounts, setAccounts] = useState([])
    const [selectedAccount, setSelectedAccount] = useState(null)
    const [toPhone, setToPhone] = useState('')
    const [message, setMessage] = useState('')
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState(null)
    const [error, setError] = useState(null)
    const [history, setHistory] = useState([])

    useEffect(() => {
        fetchAccounts()
        // Load message history from localStorage
        const saved = localStorage.getItem('messageHistory')
        if (saved) setHistory(JSON.parse(saved).slice(0, 10))
    }, [])

    useEffect(() => {
        // Pre-select account from URL param
        const fromPhone = searchParams.get('from')
        if (fromPhone && accounts.length > 0) {
            const account = accounts.find(a => a.phone === decodeURIComponent(fromPhone))
            if (account) setSelectedAccount(account)
        }
    }, [searchParams, accounts])

    const fetchAccounts = async () => {
        const allAccounts = await fetchAllAccounts()
        const activeAccounts = allAccounts.filter(a => a.connected && a.logged_in)
        setAccounts(activeAccounts)
        if (activeAccounts.length > 0 && !selectedAccount) {
            setSelectedAccount(activeAccounts[0])
        }
    }

    const handleSendMessage = async () => {
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
            const data = await sendMessage(
                selectedAccount.phone,
                cleanToPhone,
                message,
                selectedAccount.workerPort
            )

            const historyItem = {
                id: Date.now(),
                from: selectedAccount.phone,
                to: cleanToPhone,
                message: message.slice(0, 50) + (message.length > 50 ? '...' : ''),
                timestamp: new Date().toLocaleString(),
                success: true
            }

            const newHistory = [historyItem, ...history].slice(0, 10)
            setHistory(newHistory)
            localStorage.setItem('messageHistory', JSON.stringify(newHistory))

            setResult({
                success: true,
                messageId: data.message_id,
                timestamp: new Date().toLocaleTimeString()
            })
            setMessage('')
        } catch (err) {
            setError(err.message)

            const historyItem = {
                id: Date.now(),
                from: selectedAccount.phone,
                to: cleanToPhone,
                message: message.slice(0, 50) + (message.length > 50 ? '...' : ''),
                timestamp: new Date().toLocaleString(),
                success: false,
                error: err.message
            }

            const newHistory = [historyItem, ...history].slice(0, 10)
            setHistory(newHistory)
            localStorage.setItem('messageHistory', JSON.stringify(newHistory))
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
            {/* Header */}
            <div>
                <h2 className="text-3xl font-bold text-white mb-2">Send Message</h2>
                <p className="text-gray-400">Send a WhatsApp message from a connected account</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Main Form */}
                <div className="lg:col-span-2 space-y-6">
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
                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                    {accounts.map((account) => (
                                        <button
                                            key={account.phone}
                                            onClick={() => setSelectedAccount(account)}
                                            className={`w-full p-3 rounded-xl border text-left transition-all duration-200 ${selectedAccount?.phone === account.phone
                                                    ? 'bg-wa-green/20 border-wa-green'
                                                    : 'bg-wa-bg border-wa-border hover:border-wa-green/50'
                                                }`}
                                        >
                                            <div className="flex items-center gap-3">
                                                <span className="text-xl">{account.workerFlag}</span>
                                                <div className="flex-1">
                                                    <div className="text-white font-medium">{account.phone}</div>
                                                    <div className="text-xs text-gray-500">{account.worker}</div>
                                                </div>
                                                {selectedAccount?.phone === account.phone && (
                                                    <span className="text-wa-green text-xl">✓</span>
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
                                    ID: {result.messageId} • {result.timestamp}
                                </p>
                            </div>
                        )}

                        {/* Send Button */}
                        <button
                            onClick={handleSendMessage}
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
                </div>

                {/* Sidebar */}
                <div className="space-y-6">
                    {/* Quick Templates */}
                    <div className="card">
                        <h3 className="text-lg font-semibold text-white mb-4">📝 Templates</h3>
                        <div className="space-y-2">
                            {[
                                { label: '👋 Hello', text: 'היי, מה שלומך?' },
                                { label: '🙏 Thanks', text: 'תודה רבה!' },
                                { label: '👍 OK', text: 'בסדר, מקובל עליי' },
                                { label: '⏰ Later', text: 'אחזור אליך בהמשך' },
                                { label: '❓ Question', text: 'יש לי שאלה...' },
                                { label: '📞 Call', text: 'אפשר להתקשר?' },
                            ].map((template) => (
                                <button
                                    key={template.label}
                                    onClick={() => setMessage(template.text)}
                                    className="w-full p-2 bg-wa-bg border border-wa-border rounded-lg text-sm text-gray-300
                             hover:border-wa-green/50 hover:text-white transition-all duration-200 text-left"
                                >
                                    {template.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Message History */}
                    <div className="card">
                        <h3 className="text-lg font-semibold text-white mb-4">📜 History</h3>
                        {history.length === 0 ? (
                            <p className="text-gray-500 text-sm">No messages sent yet</p>
                        ) : (
                            <div className="space-y-3 max-h-64 overflow-y-auto">
                                {history.map((item) => (
                                    <div
                                        key={item.id}
                                        className={`p-3 rounded-lg text-xs ${item.success
                                                ? 'bg-green-500/10 border border-green-500/20'
                                                : 'bg-red-500/10 border border-red-500/20'
                                            }`}
                                    >
                                        <div className="flex justify-between mb-1">
                                            <span className="text-gray-400">To: {item.to}</span>
                                            <span className={item.success ? 'text-green-400' : 'text-red-400'}>
                                                {item.success ? '✓' : '✗'}
                                            </span>
                                        </div>
                                        <p className="text-gray-300 truncate">{item.message}</p>
                                        <p className="text-gray-500 mt-1">{item.timestamp}</p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

export default SendMessage
