import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { WORKERS, getWorkerForPhone, detectCountry, requestPairingCode } from '../api/workers'
import PairingCodeModal from '../components/PairingCodeModal'

function AddAccount() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('+')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [pairingResult, setPairingResult] = useState(null)

  const country = detectCountry(phone)
  const worker = getWorkerForPhone(phone)

  async function handleSubmit(e) {
    e.preventDefault()
    
    if (phone.length < 8) {
      setError('Please enter a valid phone number')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const result = await requestPairingCode(worker, phone)
      setPairingResult(result)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handlePhoneChange(e) {
    let value = e.target.value
    // Ensure starts with +
    if (!value.startsWith('+')) {
      value = '+' + value.replace(/[^0-9]/g, '')
    } else {
      value = '+' + value.slice(1).replace(/[^0-9]/g, '')
    }
    setPhone(value)
  }

  return (
    <div className="animate-fade-in max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Add Account</h1>
        <p className="text-dark-400">Connect a new WhatsApp account using pairing code</p>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Phone Input */}
          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">
              Phone Number
            </label>
            <div className="relative">
              <input
                type="tel"
                value={phone}
                onChange={handlePhoneChange}
                placeholder="+1234567890"
                className="input text-xl font-mono pl-16"
                disabled={loading}
              />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-2xl">
                {country.flag}
              </span>
            </div>
            <p className="mt-2 text-sm text-dark-400">
              Include country code (e.g., +1 for US, +972 for Israel, +44 for UK)
            </p>
          </div>

          {/* Country Detection */}
          {phone.length > 2 && (
            <div className="p-4 bg-dark-700/50 rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-dark-400">Detected Country</span>
                <span className="text-white font-medium">
                  {country.flag} {country.name}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-dark-400">Assigned Worker</span>
                <span className="text-white font-medium">
                  {worker.name} ({worker.country})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-dark-400">Worker Port</span>
                <span className="text-dark-300 font-mono text-sm">
                  {worker.port}
                </span>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
              {error}
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading || phone.length < 8}
            className="btn-primary w-full py-3 text-lg flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Getting Pairing Code...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Get Pairing Code
              </>
            )}
          </button>
        </form>

        {/* Instructions */}
        <div className="mt-8 pt-6 border-t border-dark-700">
          <h3 className="text-lg font-semibold text-white mb-4">How it works</h3>
          <ol className="space-y-3">
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-wa-green/20 text-wa-green rounded-full flex items-center justify-center text-sm font-medium">1</span>
              <span className="text-dark-300">Enter your WhatsApp phone number with country code</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-wa-green/20 text-wa-green rounded-full flex items-center justify-center text-sm font-medium">2</span>
              <span className="text-dark-300">Click "Get Pairing Code" to receive an 8-digit code</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-wa-green/20 text-wa-green rounded-full flex items-center justify-center text-sm font-medium">3</span>
              <span className="text-dark-300">Open WhatsApp → Settings → Linked Devices → Link a Device</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 bg-wa-green/20 text-wa-green rounded-full flex items-center justify-center text-sm font-medium">4</span>
              <span className="text-dark-300">Tap "Link with phone number instead" and enter the code</span>
            </li>
          </ol>
        </div>
      </div>

      {/* Pairing Code Modal */}
      {pairingResult && (
        <PairingCodeModal
          result={pairingResult}
          onClose={() => {
            setPairingResult(null)
            navigate('/accounts')
          }}
        />
      )}
    </div>
  )
}

export default AddAccount

