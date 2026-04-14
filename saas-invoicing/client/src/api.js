import axios from 'axios'

const baseURL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:5000/api'
    : 'https://invoxa-54f0.onrender.com/api'

const api = axios.create({
  baseURL,
  withCredentials: true
})

api.interceptors.request.use((config) => {
  // ✅ FIX: sessionStorage instead of localStorage
  const token = sessionStorage.getItem('token')

  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // ✅ FIX: only clear session storage
      sessionStorage.clear()
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default api