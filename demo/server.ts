import express from 'express'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json())

// ---------------------------------------------------------------------------
// In-memory store (demo only -- not thread-safe, not persistent)
// ---------------------------------------------------------------------------

type Order = {
  id: string
  userId: string
  sku: string
  quantity: number
  status: 'confirmed' | 'cancelled'
  createdAt: string
}

const users: Record<string, { email: string; password: string; firstName: string }> = {
  'user-1': { email: 'buyer@example.com', password: 'password123', firstName: 'Winton' },
  'admin-1': { email: 'admin@example.com', password: 'adminpass', firstName: 'Admin' },
}

const tokens: Record<string, string> = {} // token -> userId
const orders: Record<string, Order> = {}
// Simulated side-effect log (logRecorded) and event bus (eventPublished)
const orderLog: Set<string> = new Set()
const orderEvents: Set<string> = new Set()

const products = [
  { sku: 'sku_123', name: 'Widget', description: 'A standard widget', price: 19.99 },
  { sku: 'sku_999', name: 'Widget Pro', description: 'A premium widget', price: 49.99 },
]

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function authenticate(req: express.Request): string | null {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  return tokens[token] ?? null
}

// ---------------------------------------------------------------------------
// Static HTML pages
// ---------------------------------------------------------------------------

const pagesDir = join(__dirname, 'pages')

app.get('/login', (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(readFileSync(join(pagesDir, 'login.html')))
})

app.get('/products', (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(readFileSync(join(pagesDir, 'products.html')))
})

app.get('/orders/:id', (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(readFileSync(join(pagesDir, 'orders.html')))
})

// ---------------------------------------------------------------------------
// API: health
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// ---------------------------------------------------------------------------
// API: auth
// ---------------------------------------------------------------------------

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string }
  if (!email || !password) {
    res.status(400).json({ error: 'email and password required' })
    return
  }
  const user = Object.entries(users).find(([, u]) => u.email === email && u.password === password)
  if (!user) {
    res.status(401).json({ error: 'invalid credentials' })
    return
  }
  const token = randomUUID()
  tokens[token] = user[0]
  res.json({ token, userId: user[0], firstName: user[1].firstName })
})

// ---------------------------------------------------------------------------
// API: products
// ---------------------------------------------------------------------------

app.get('/api/products', (req, res) => {
  const skuFilter = req.query['sku'] as string | undefined
  const result = skuFilter ? products.filter(p => p.sku === skuFilter) : products
  res.json(result)
})

// ---------------------------------------------------------------------------
// API: orders
// ---------------------------------------------------------------------------

app.post('/api/orders', (req, res) => {
  const userId = authenticate(req)
  if (!userId) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  const { sku, quantity } = req.body as { sku?: string; quantity?: number }
  if (!sku || typeof quantity !== 'number') {
    res.status(400).json({ error: 'sku and quantity required' })
    return
  }
  if (!products.find(p => p.sku === sku)) {
    res.status(404).json({ error: 'product not found' })
    return
  }
  const id = randomUUID()
  const order: Order = {
    id,
    userId,
    sku,
    quantity,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  }
  orders[id] = order
  // Simulate side effects
  orderLog.add(id)
  orderEvents.add(id)
  res.status(201).json(order)
})

app.get('/api/orders/:id', (req, res) => {
  const userId = authenticate(req)
  if (!userId) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  const order = orders[req.params['id'] ?? '']
  if (!order) {
    res.status(404).json({ error: 'order not found' })
    return
  }
  if (order.userId !== userId) {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  res.json(order)
})

// ---------------------------------------------------------------------------
// Verification endpoint -- exposes system state through HTTP (the correct pattern)
// ---------------------------------------------------------------------------

app.get('/_verify/orders/:id', (req, res) => {
  const orderId = req.params['id'] ?? ''
  const orderExists = orderId in orders
  const logRecorded = orderLog.has(orderId)
  const eventPublished = orderEvents.has(orderId)
  res.json({ orderExists, logRecorded, eventPublished })
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function startServer(port = 3737): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(port, () => {
      console.log(`Ortheon demo server running at http://localhost:${port}`)
      resolve(server)
    })
  })
}

// Run directly if invoked as main module
const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const port = parseInt(process.env['PORT'] ?? '3737', 10)
  startServer(port)
}
