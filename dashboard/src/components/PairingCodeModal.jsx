import { useState, useEffect } from 'react'

function PairingCodeModal({ result, onClose }) {
  const [copied, setCopied] = useState(false)
  const [timeLeft, setTimeLeft] = useState(120) // 2 minutes

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  function copyCode() {
    navigator.clipboard.writeText(result.pairing_code.replace('-', ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-dark-800 border border-dark-700 rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-wa-green/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-wa-green" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Pairing Code</h2>
          <p className="text-dark-400">Enter this code in WhatsApp to link your device</p>
        </div>

        {/* Pairing Code Display */}
        <div className="bg-dark-900 rounded-xl p-6 mb-6">
          <div className="text-center">
            <div className="text-5xl font-mono font-bold text-wa-green tracking-wider mb-4">
              {result.pairing_code}
            </div>
            <button
              onClick={copyCode}
              className="btn-secondary text-sm flex items-center gap-2 mx-auto"
            >
              {copied ? (
                <>
                  <svg className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Code
                </>
              )}
            </button>
          </div>
        </div>

        {/* Timer */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <svg className="w-5 h-5 text-dark-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className={`font-mono ${timeLeft < 30 ? 'text-red-400' : 'text-dark-400'}`}>
            Expires in {formatTime(timeLeft)}
          </span>
        </div>

        {/* Instructions */}
        <div className="bg-dark-700/50 rounded-lg p-4 mb-6">
          <h3 className="text-sm font-semibold text-white mb-3">How to link:</h3>
          <ol className="space-y-2 text-sm text-dark-300">
            <li className="flex items-start gap-2">
              <span className="text-wa-green font-medium">1.</span>
              Open WhatsApp on your phone
            </li>
            <li className="flex items-start gap-2">
              <span className="text-wa-green font-medium">2.</span>
              Go to Settings → Linked Devices
            </li>
            <li className="flex items-start gap-2">
              <span className="text-wa-green font-medium">3.</span>
              Tap "Link a Device"
            </li>
            <li className="flex items-start gap-2">
              <span className="text-wa-green font-medium">4.</span>
              Tap "Link with phone number instead"
            </li>
            <li className="flex items-start gap-2">
              <span className="text-wa-green font-medium">5.</span>
              Enter the code: <span className="font-mono text-wa-green">{result.pairing_code}</span>
            </li>
          </ol>
        </div>

        {/* Phone Info */}
        <div className="text-center text-sm text-dark-400 mb-6">
          Phone: <span className="text-white font-mono">{result.phone}</span>
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="btn-secondary w-full py-3"
        >
          Done
        </button>
      </div>
    </div>
  )
}

export default PairingCodeModal

