import axios from 'axios'

const baseURL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:5000/api'
    : 'https://calm-spontaneity-production-f15e.up.railway.app/api' 

const api = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 10000 
})

api.interceptors.request.use((config) => {
  const token = sessionStorage.getItem('token')

  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    // 🔒 Auto logout if token expired
    if (error.response?.status === 401) {
      sessionStorage.clear()
      window.location.href = '/login'
    }

    // 🌐 Backend unreachable (Railway cold start / network issue)
    if (!error.response) {
      console.error('Server unreachable')
    }

    return Promise.reject(error)
  }
)

export default api