import { Link } from 'react-router-dom'

export default function Landing() {
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">

      {/* Navbar */}
      <nav className="px-6 py-4 sticky top-0 z-50 bg-gray-900 border-b border-gray-800">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">
            Invoxa <span className="text-blue-400">.</span>
          </h1>
          <div className="flex items-center gap-4">
            <Link
              to="/login"
              className="text-sm font-medium text-gray-300 hover:text-white transition"
            >
              Sign in
            </Link>
            <Link
              to="/register"
              className="text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-lg transition"
            >
              Get started free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center relative overflow-hidden">

        {/* Background glow */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-600 opacity-10 rounded-full blur-3xl"></div>
        </div>

        <div className="max-w-4xl mx-auto relative">

          <div className="inline-block bg-blue-600 bg-opacity-20 border border-blue-500 border-opacity-30 text-blue-400 text-sm font-medium px-4 py-1.5 rounded-full mb-8">
            🇰🇪 Built for Kenyan businesses
          </div>

          <h1 className="text-5xl md:text-6xl font-bold text-white leading-tight mb-6">
            Invoice smarter,<br />
            <span className="text-blue-400">get paid faster</span>
          </h1>

          <p className="text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Invoxa is the easiest way for Kenyan SMEs to create professional invoices,
            collect M-Pesa payments and track their business revenue all in one place.
          </p>

          <div className="flex items-center justify-center gap-4 flex-wrap mb-5">
            <Link
              to="/register"
              className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-8 py-4 rounded-xl transition text-lg shadow-lg shadow-blue-900"
            >
              Get started free →
            </Link>
            <Link
              to="/login"
              className="bg-white bg-opacity-10 hover:bg-opacity-20 text-white font-semibold px-8 py-4 rounded-xl transition text-lg border border-white border-opacity-20"
            >
              Sign in
            </Link>
          </div>

          <p className="text-sm text-gray-500 mb-10">
            No credit card required · Free to get started
          </p>

          {/* Feature pills */}
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <span className="bg-gray-800 border border-gray-700 text-gray-400 text-xs font-medium px-4 py-2 rounded-full">
              📄 Professional Invoices
            </span>
            <span className="bg-gray-800 border border-gray-700 text-gray-400 text-xs font-medium px-4 py-2 rounded-full">
              📱 M-Pesa STK Push
            </span>
            <span className="bg-gray-800 border border-gray-700 text-gray-400 text-xs font-medium px-4 py-2 rounded-full">
              📊 Revenue Dashboard
            </span>
            <span className="bg-gray-800 border border-gray-700 text-gray-400 text-xs font-medium px-4 py-2 rounded-full">
              📥 PDF Export
            </span>
            <span className="bg-gray-800 border border-gray-700 text-gray-400 text-xs font-medium px-4 py-2 rounded-full">
              🔒 Secure & Multi-Tenant
            </span>
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-6 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between flex-wrap gap-4">
          <p className="text-white font-bold">
            Invoxa <span className="text-blue-400">.</span>
          </p>
          <p className="text-gray-500 text-sm">
            Built by Anthony Malawa
          </p>
          <div className="flex gap-6 text-sm text-gray-500">
            <Link to="/register" className="hover:text-blue-400">Register</Link>
            <Link to="/login" className="hover:text-blue-400">Login</Link>
          </div>
        </div>
      </footer>

    </div>
  )
}