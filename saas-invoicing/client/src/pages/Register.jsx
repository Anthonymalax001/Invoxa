import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../api'

export default function Register() {
  const navigate = useNavigate()

  const [form, setForm] = useState({
    businessName: '',
    email: '',
    password: '',
    phone: ''
  })

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const handleChange = (e) => {
    let { name, value } = e.target

    // ✅ enforce 10-digit phone only
    if (name === 'phone') {
      value = value.replace(/\D/g, '').slice(0, 10)
    }

    setForm({ ...form, [name]: value })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    // ✅ validate phone
    if (form.phone.length !== 10) {
      return setError('Phone number must be exactly 10 digits (e.g. 0712345678)')
    }

    setLoading(true)

    try {
      await api.post('/auth/register', form)

      setSuccess(true)

      setTimeout(() => {
        navigate('/login')
      }, 2000)

    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-blue-600">Invoxa</h1>
          <p className="text-gray-500 mt-2">Create your free business account</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-md p-8">

          {success ? (
            <div className="text-center py-6">
              <div className="text-5xl mb-4">🎉</div>
              <h3 className="text-lg font-semibold text-gray-800 mb-2">
                Account created successfully!
              </h3>
              <p className="text-gray-500 text-sm">
                Redirecting you to login...
              </p>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-4 bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-3">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">

                {/* Business Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Business name
                  </label>
                  <input
                    type="text"
                    name="businessName"
                    value={form.businessName}
                    onChange={handleChange}
                    required
                    placeholder="e.g. Wanjiku Supplies"
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Email */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Email address
                  </label>
                  <input
                    type="email"
                    name="email"
                    value={form.email}
                    onChange={handleChange}
                    required
                    placeholder="you@business.com"
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Phone */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone number
                  </label>
                  <input
                    type="tel"
                    name="phone"
                    value={form.phone}
                    onChange={handleChange}
                    required
                    placeholder="0712345678"
                    className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Password with toggle */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Password
                  </label>

                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      name="password"
                      value={form.password}
                      onChange={handleChange}
                      required
                      minLength={8}
                      placeholder="Min 8 characters"
                      className="w-full border border-gray-300 rounded-lg px-4 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />

                    <span
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-2.5 cursor-pointer text-gray-400 text-sm"
                    >
                      {showPassword ? '🙈' : '👁️'}
                    </span>
                  </div>
                </div>

                {/* Button */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50"
                >
                  {loading ? 'Creating account...' : 'Create account'}
                </button>

              </form>

              <p className="text-center text-sm text-gray-500 mt-6">
                Already have an account?{' '}
                <Link to="/login" className="text-blue-600 font-medium hover:underline">
                  Sign in
                </Link>
              </p>
            </>
          )}

        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          By registering you agree to our Terms of Service
        </p>

      </div>
    </div>
  )
}