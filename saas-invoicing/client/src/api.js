import axios from 'axios'

const baseURL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:5000/api'
    : 'https://invoxa-54f0.onrender.com/api'

const api = axios.create({
  baseURL,
  withCredentials: true,
  timeout: 10000 // ✅ prevents hanging requests
})

api.interceptors.request.use((config) => {
  // ✅ use sessionStorage
  const token = sessionStorage.getItem('token')

  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    // ✅ handle expired token
    if (error.response?.status === 401) {
      sessionStorage.clear()
      window.location.href = '/login'
    }

    // ✅ handle backend down (Render/Railway cold start)
    if (!error.response) {
      console.error('Server unreachable')
    }

    return Promise.reject(error)
  }
)

export default api