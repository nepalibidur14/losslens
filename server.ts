import 'dotenv/config'
import path from 'node:path'
import express, { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { createShop, deleteAllSandboxes, getShop, runBacktest, warmSpare } from './tools'
import { friendlyError, runAgent } from './agent'

const app = express()
const PORT = Number(process.env.PORT ?? 4000)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// M1: shop uploads its sales CSV once -> one private Daytona sandbox per shop.
app.post('/api/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'Please choose a CSV file (form field name: "file").' })
    return
  }
  console.log(`[upload] got ${req.file.originalname} (${req.file.size} bytes)`)
  try {
    const { shopId, sandboxId, summary, setupMs, warm } = await createShop(req.file.buffer)
    res.json({ shopId, sandboxId, summary, toolsUsed: ['daytona'], setupMs, warm })
  } catch (err) {
    console.error('[upload] failed:', (err as Error).message)
    res.status(500).json({ error: 'Could not prepare your shop sandbox. Please try again.', detail: (err as Error).message })
  }
})

// M2: ask a question -> Claude agent loop with run_python in the shop's sandbox.
app.post('/api/chat', async (req: Request, res: Response) => {
  const { shopId, message, history } = req.body ?? {}
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'Please type a question.' })
    return
  }
  if (typeof shopId !== 'string' || !getShop(shopId)) {
    res.status(404).json({ error: 'Shop not found. Please upload your CSV first.' })
    return
  }
  try {
    const result = await runAgent(shopId, message.trim().slice(0, 2000), history)
    res.json(result)
  } catch (err) {
    console.error('[chat] failed:', err)
    res.status(500).json({ error: friendlyError(err) })
  }
})

// Item 9: fixed 30-day backtest in the shop's sandbox (same number every time).
app.post('/api/backtest', async (req: Request, res: Response) => {
  const { shopId } = req.body ?? {}
  if (typeof shopId !== 'string' || !getShop(shopId)) {
    res.status(404).json({ error: 'Shop not found. Please upload your CSV first.' })
    return
  }
  try {
    res.json(await runBacktest(shopId))
  } catch (err) {
    console.error('[backtest] failed:', (err as Error).message)
    res.status(500).json({ error: 'Could not run the backtest.' })
  }
})

// Friendly JSON for multer errors (wrong field name, file too big) and anything else.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] error:', err.message)
  res.status(400).json({ error: `Upload problem: ${err.message}` })
})

const server = app.listen(PORT, () => {
  console.log(`LossLens running at http://localhost:${PORT}`)
  warmSpare()
})

let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[server] ${signal} received, deleting sandboxes...`)
  server.close()
  await deleteAllSandboxes()
  console.log('[server] bye')
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

// Never crash the server during the demo.
process.on('unhandledRejection', (err) => console.error('[server] unhandledRejection:', err))
process.on('uncaughtException', (err) => console.error('[server] uncaughtException:', err))
