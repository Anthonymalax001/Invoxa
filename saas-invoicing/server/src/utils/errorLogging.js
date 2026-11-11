const path = require('node:path')

const SOURCE_ROOT = path.resolve(__dirname, '..')
const SAFE_NAMES = new Set([
  'Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'URIError',
  'AggregateError', 'AssertionError', 'DatabaseError', 'PostgresError', 'AxiosError',
  'RequestError', 'FetchError', 'JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'
])
const SAFE_CODE = /^(?:[0-9A-Z]{5}|E[A-Z0-9_]{1,20}|ERR_[A-Z0-9_]{1,40}|CORS_ORIGIN_DENIED)$/
const SAFE_TYPE = /^(?:entity\.parse\.failed|entity\.too\.large)$/
const SAFE_EVENT = /^[A-Za-z0-9 _-]{1,100}$/
const SAFE_ROUTE = /^[A-Za-z0-9_/:.-]{1,160}$/

function safeName(value) {
  return typeof value === 'string' && SAFE_NAMES.has(value) ? value : undefined
}

function safeCode(value) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined
}

function sourceFrames(error) {
  if (typeof error?.stack !== 'string') return []

  return error.stack.split('\n').slice(1).flatMap((line) => {
    const match = line.match(/^\s*at .+?\((.+):(\d+):(\d+)\)\s*$/) ||
      line.match(/^\s*at (.+):(\d+):(\d+)\s*$/)
    if (!match || !path.isAbsolute(match[1])) return []

    const location = path.resolve(match[1])
    const relative = path.relative(SOURCE_ROOT, location)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return []
    return [`${relative}:${match[2]}:${match[3]}`]
  }).slice(0, 6)
}

function logSafeError(event, error, {
  includeFrames = true,
  method,
  route,
  status
} = {}) {
  const label = typeof event === 'string' && SAFE_EVENT.test(event) ? event : 'Request error'
  const metadata = {
    error: {
      name: safeName(error?.name) || 'Error'
    }
  }

  const code = safeCode(error?.code)
  const type = typeof error?.type === 'string' && SAFE_TYPE.test(error.type) ? error.type : undefined
  if (code) metadata.error.code = code
  if (type) metadata.error.type = type
  if (Number.isInteger(status) && status >= 400 && status <= 599) metadata.status = status
  if (typeof method === 'string' && /^[A-Z]{3,10}$/.test(method)) metadata.method = method
  if (typeof route === 'string' && SAFE_ROUTE.test(route)) metadata.route = route

  if (includeFrames) {
    const frames = sourceFrames(error)
    if (frames.length) metadata.error.frames = frames
  }

  console.error(label, metadata)
}

module.exports = { logSafeError }
