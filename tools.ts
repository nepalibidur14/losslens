import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Daytona, Sandbox } from '@daytona/sdk'
import { tavily } from '@tavily/core'

export const CSV_PATH = '/tmp/shop/sales.csv'
export const CHART_PATH = '/tmp/shop/chart.png'
export const HELPER_PATH = '/tmp/shop/losslens.py'
const HELPER_CODE = readFileSync(path.join(__dirname, 'losslens.py'))

export type ShopSummary = {
  rows: number
  dateFrom: string
  dateTo: string
  days: number
  items: string[]
}

type Shop = { sandbox: Sandbox; summary: ShopSummary; createdAt: number; backtest?: Promise<BacktestResult> }

export type BacktestResult = Record<string, unknown> & { netSaving: number; ms: number }

const shops = new Map<string, Shop>()
let daytona: Daytona | null = null

function getDaytona(): Daytona {
  if (!daytona) daytona = new Daytona()
  return daytona
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

const SUMMARY_CODE = `
import json, pandas as pd
df = pd.read_csv('${CSV_PATH}', encoding='utf-8-sig')
d = pd.to_datetime(df['date'])
print(json.dumps({
  'rows': int(len(df)),
  'dateFrom': d.min().strftime('%Y-%m-%d'),
  'dateTo': d.max().strftime('%Y-%m-%d'),
  'days': int(d.nunique()),
  'items': [str(x) for x in df['item'].unique()],
}, ensure_ascii=False))
`

async function createSandbox(): Promise<Sandbox> {
  const dt = getDaytona()
  try {
    // Stop after 120 min idle (default is 15), delete 30 min after stop as a safety net.
    return await dt.create({ language: 'python', autoStopInterval: 120, autoDeleteInterval: 30 })
  } catch (err) {
    log(`[daytona] create with intervals failed (${(err as Error).message}), retrying plain`)
    return await dt.create({ language: 'python' })
  }
}

/** Create a sandbox and install the Python libs. Deletes the sandbox if setup fails. */
async function prepareSandbox(): Promise<Sandbox> {
  const t0 = Date.now()
  log('[daytona] creating sandbox...')
  const sandbox = await createSandbox()
  log(`[daytona] sandbox ${sandbox.id} created (${Date.now() - t0} ms)`)
  try {
    log('[daytona] pip install pandas matplotlib jpholiday...')
    const pip = await sandbox.process.executeCommand('pip install -q pandas matplotlib jpholiday', undefined, undefined, 300)
    if (pip.exitCode !== 0) throw new Error(`pip install failed: ${pip.result.slice(-500)}`)
    await sandbox.process.executeCommand('mkdir -p /tmp/shop')
    log(`[daytona] sandbox ${sandbox.id} prepared (${Date.now() - t0} ms)`)
    return sandbox
  } catch (err) {
    log(`[daytona] prepare failed, deleting sandbox ${sandbox.id}`)
    await sandbox.delete().catch(() => {})
    throw err
  }
}

// Item 6: keep one prepared sandbox ready, so the upload on stage only copies the CSV.
let spare: Promise<Sandbox | null> | null = null

export function warmSpare(): void {
  if (spare) return
  log('[daytona] warming a spare sandbox in the background...')
  spare = prepareSandbox().catch((err) => {
    log(`[daytona] spare warm-up failed: ${(err as Error).message}`)
    return null
  })
}

/** Take the spare sandbox if it is ready (or still warming up). Returns null if there is no usable spare. */
async function takeSpare(): Promise<Sandbox | null> {
  if (!spare) return null
  const p = spare
  spare = null
  const sandbox = await p
  if (!sandbox) return null
  try {
    await sandbox.refreshData()
    if (sandbox.state === 'started') return sandbox
    log(`[daytona] spare ${sandbox.id} is "${sandbox.state}", not started - making a new one`)
  } catch (err) {
    log(`[daytona] spare check failed: ${(err as Error).message}`)
  }
  sandbox.delete().catch(() => {})
  return null
}

/** Give a shop its own sandbox (spare if ready), upload the CSV, return shopId + summary. */
export async function createShop(
  csv: Buffer,
): Promise<{ shopId: string; sandboxId: string; summary: ShopSummary; setupMs: number; warm: boolean }> {
  const t0 = Date.now()
  const fromSpare = await takeSpare()
  const warm = !!fromSpare
  const sandbox = fromSpare ?? (await prepareSandbox())
  log(`[daytona] using ${warm ? 'warm spare' : 'new'} sandbox ${sandbox.id} (${Date.now() - t0} ms)`)
  warmSpare() // get the next one ready for the next upload
  try {
    await sandbox.fs.uploadFile(csv, CSV_PATH)
    await sandbox.fs.uploadFile(HELPER_CODE, HELPER_PATH)
    log(`[daytona] uploaded CSV (${csv.length} bytes) -> ${CSV_PATH} and helper -> ${HELPER_PATH}`)

    const res = await sandbox.process.codeRun(SUMMARY_CODE)
    if (res.exitCode !== 0) throw new Error(`summary failed: ${res.result.slice(-500)}`)
    const lastLine = res.result.trim().split('\n').pop() ?? ''
    const summary = JSON.parse(lastLine) as ShopSummary

    const shopId = randomUUID()
    shops.set(shopId, { sandbox, summary, createdAt: Date.now() })
    const setupMs = Date.now() - t0
    log(`[daytona] shop ${shopId} ready: ${summary.rows} rows, ${summary.items.length} items (${setupMs} ms total)`)
    return { shopId, sandboxId: sandbox.id, summary, setupMs, warm }
  } catch (err) {
    log(`[daytona] setup failed, deleting sandbox ${sandbox.id}`)
    await sandbox.delete().catch((e) => log(`[daytona] delete failed: ${(e as Error).message}`))
    throw err
  }
}

export function getShop(shopId: string): Shop | undefined {
  return shops.get(shopId)
}

export type PythonResult = { ok: boolean; output: string; chartBase64?: string }

const MAX_OUTPUT_CHARS = 8000

/** Tool: run pandas code in the shop's sandbox. Returns stdout (or the error) and the chart if one was saved. */
export async function runPython(shopId: string, code: string): Promise<PythonResult> {
  const shop = shops.get(shopId)
  if (!shop) return { ok: false, output: 'No sandbox for this shop. Ask the user to upload the CSV again.' }
  const { sandbox } = shop
  const t0 = Date.now()
  const firstLine = code.trim().split('\n').find((l) => l.trim() && !l.trim().startsWith('import')) ?? ''
  log(`[tool] run_python (${code.split('\n').length} lines): ${firstLine.slice(0, 90)}`)

  try {
    await sandbox.process.executeCommand(`rm -f ${CHART_PATH}`)
    const res = await sandbox.process.codeRun(code, { env: { MPLBACKEND: 'Agg' } }, 120)
    let output = res.result ?? ''
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... [output cut at ${MAX_OUTPUT_CHARS} chars - print less]`
    }
    const ok = res.exitCode === 0
    log(`[tool] run_python ${ok ? 'OK' : `ERROR exit=${res.exitCode}`} (${Date.now() - t0} ms, ${output.length} chars)`)
    if (!ok) return { ok, output: output || `Python exited with code ${res.exitCode}` }

    let chartBase64: string | undefined
    const check = await sandbox.process.executeCommand(`test -f ${CHART_PATH} && echo yes || echo no`)
    if (check.result.trim() === 'yes') {
      const png = await sandbox.fs.downloadFile(CHART_PATH)
      chartBase64 = png.toString('base64')
      log(`[tool] chart downloaded (${png.length} bytes)`)
    }
    return { ok, output: output || '(no output - use print() to show results)', chartBase64 }
  } catch (err) {
    log(`[tool] run_python FAILED: ${(err as Error).message}`)
    return { ok: false, output: `Sandbox error: ${(err as Error).message}` }
  }
}

// Item 9: fixed backtest script (not AI-written), run once per shop in its sandbox and cached.
const BACKTEST_CODE = `
import sys, json
sys.path.insert(0, '/tmp/shop')
from losslens import backtest
print(json.dumps(backtest(days=30), ensure_ascii=False))
`

export function runBacktest(shopId: string): Promise<BacktestResult> {
  const shop = shops.get(shopId)
  if (!shop) return Promise.reject(new Error('shop not found'))
  if (!shop.backtest) {
    shop.backtest = (async () => {
      const t0 = Date.now()
      log(`[tool] backtest (fixed script) for shop ${shopId}...`)
      const res = await shop.sandbox.process.codeRun(BACKTEST_CODE, undefined, 120)
      if (res.exitCode !== 0) throw new Error(`backtest failed: ${res.result.slice(-300)}`)
      const out = JSON.parse(res.result.trim().split('\n').pop() ?? '{}')
      const ms = Date.now() - t0
      log(`[tool] backtest OK: net saving ¥${out.netSaving} over ${out.days} days (${ms} ms)`)
      return { ...out, ms }
    })()
    shop.backtest.catch(() => {
      shop.backtest = undefined // allow a retry
    })
  }
  return shop.backtest
}

// M4: tomorrow's weather + local events from Tavily. Tomorrow is computed in Asia/Tokyo time.
let tvly: ReturnType<typeof tavily> | null = null

export function tomorrowTokyo(): { date: string; weekday: string; jpLabel: string; year: number } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date()) // YYYY-MM-DD
  const [y, m, d] = today.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  return {
    date: t.toISOString().slice(0, 10),
    weekday: '日月火水木金土'[t.getUTCDay()],
    jpLabel: `${t.getUTCMonth() + 1}月${t.getUTCDate()}日`,
    year: t.getUTCFullYear(),
  }
}

type SearchSummary = { summary: string; sources: { title: string; url: string; snippet: string }[] } | { error: string }

export async function getTomorrowContext(area: string): Promise<{ ok: boolean; queries: string; output: string }> {
  const place = area.trim() || '東京都品川区'
  const tm = tomorrowTokyo()
  const qWeather = `${place} 天気予報 ${tm.jpLabel}(${tm.weekday})`
  const qEvents = `${place} イベント ${tm.year}年${tm.jpLabel}`
  const queries = `${qWeather}\n${qEvents}`
  const t0 = Date.now()
  log(`[tool] get_tomorrow_context: ${place} for ${tm.date} (${tm.weekday})`)
  if (!tvly) tvly = tavily({ apiKey: process.env.TAVILY_API_KEY ?? '' })
  const client = tvly
  const search = async (q: string): Promise<SearchSummary> => {
    try {
      const r = await client.search(q, { maxResults: 4, includeAnswer: true, searchDepth: 'basic', timeout: 15 })
      return {
        summary: r.answer ?? '',
        sources: r.results.map((x) => ({
          title: x.title.slice(0, 100),
          url: x.url,
          snippet: x.content.replace(/\s+/g, ' ').slice(0, 200),
        })),
      }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }
  const [weather, events] = await Promise.all([search(qWeather), search(qEvents)])
  const ok = !('error' in weather) || !('error' in events)
  log(`[tool] get_tomorrow_context ${ok ? 'OK' : 'ERROR'} (${Date.now() - t0} ms)`)
  const output = JSON.stringify(
    {
      tomorrow: tm.date,
      weekday: tm.weekday,
      area: place,
      weather,
      events,
      note: 'Web search results can be old or for another date. Check the dates in titles/snippets.',
    },
    null,
    1,
  )
  return { ok, queries, output }
}

/** Delete every sandbox we created. Called on shutdown. */
export async function deleteAllSandboxes(): Promise<void> {
  const all = [...shops.entries()]
  shops.clear()
  const pending = spare
  spare = null
  if (pending) {
    const sb = await pending
    if (sb) {
      await sb
        .delete()
        .then(() => log(`[daytona] deleted spare sandbox ${sb.id}`))
        .catch((e) => log(`[daytona] could not delete spare ${sb.id}: ${(e as Error).message}`))
    }
  }
  await Promise.all(
    all.map(async ([shopId, shop]) => {
      try {
        await shop.sandbox.delete()
        log(`[daytona] deleted sandbox ${shop.sandbox.id} (shop ${shopId})`)
      } catch (err) {
        log(`[daytona] could not delete sandbox ${shop.sandbox.id}: ${(err as Error).message}`)
      }
    }),
  )
}
