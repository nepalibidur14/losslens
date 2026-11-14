// Runs the fixed Python helper (losslens.py) in a real Daytona sandbox and checks the results.
// Run: npx tsx test.ts   (needs DAYTONA_API_KEY in .env; creates and deletes sandboxes)
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { createShop, deleteAllSandboxes, runPython } from './tools'

const CHECK = `
import sys, json
sys.path.insert(0, '/tmp/shop')
from losslens import load, day_type, similar_days, suggest, holiday_mismatches
df = load()
sim = similar_days(df, 'メロンパン', '2026-11-15', '雨')
out = {
  'sunday_15nov': day_type('2026-11-15'),
  'culture_day_3nov': day_type('2026-11-03'),
  'monday_16nov': day_type('2026-11-16'),
  'sim_count': int(len(sim)),
  'sim_not_weekend_or_holiday': int((~(sim['weekday'].isin(['土', '日']) | (sim['holiday'] == '祝'))).sum()),
  'sim_months': sorted(int(m) for m in sim['date'].dt.month.unique()),
  'sim_weather': sorted(sim['weather'].unique().tolist()),
  'holiday_mismatches': holiday_mismatches(df),
  'daytype_mismatches_outside_yearend': [
    str(d.date()) for d, t in zip(df.drop_duplicates('date')['date'], df.drop_duplicates('date')['day_type'])
    if t != day_type(d) and not ((d.month == 12 and d.day >= 29) or (d.month == 1 and d.day <= 3))
  ],
  'unknown_item_no_data': bool(suggest(df, 'ドーナツ', '2026-11-15', '雨').get('no_data')),
}
print(json.dumps(out, ensure_ascii=False))
`

const BACKTEST = `
import sys, json
sys.path.insert(0, '/tmp/shop')
from losslens import backtest
print(json.dumps(backtest(days=30), ensure_ascii=False))
`

/** Independent count (no pandas): real waste cost in the last `days` days of the CSV. */
function actualWasteLastDays(days: number): { from: string; to: string; cost: number } {
  const lines = readFileSync('bakery_sales_sample.csv', 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  const h = lines[0].split(',')
  const rows = lines.slice(1).map((l) => l.split(','))
  const to = rows.map((r) => r[0]).sort().pop() as string
  const fromDate = new Date(to + 'T00:00:00Z')
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1))
  const from = fromDate.toISOString().slice(0, 10)
  let cost = 0
  for (const r of rows) if (r[0] >= from) cost += Number(r[h.indexOf('wasted')]) * Number(r[h.indexOf('unit_cost_yen')])
  return { from, to, cost }
}

type Check = { name: string; ok: boolean; detail: string }

async function main() {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: unknown) => checks.push({ name, ok, detail: JSON.stringify(detail) })
  try {
    const { shopId } = await createShop(readFileSync('bakery_sales_sample.csv'))
    const r = await runPython(shopId, CHECK)
    if (!r.ok) {
      add('helper runs', false, r.output.trim().split('\n').slice(-3).join(' | '))
    } else {
      const o = JSON.parse(r.output.trim().split('\n').pop() ?? '{}')
      add('10a. Sunday 2026-11-15 is weekend_or_holiday', o.sunday_15nov === 'weekend_or_holiday', o.sunday_15nov)
      add('10b. Tuesday 2026-11-03 (Culture Day) is weekend_or_holiday', o.culture_day_3nov === 'weekend_or_holiday', o.culture_day_3nov)
      add('10c. Monday 2026-11-16 is weekday', o.monday_16nov === 'weekday', o.monday_16nov)
      add('10d. similar days for Sunday exist', o.sim_count > 0, o.sim_count)
      add('10e. every similar day is 土/日 or 祝 in the CSV', o.sim_not_weekend_or_holiday === 0, o.sim_not_weekend_or_holiday)
      add('10f. similar days are Oct-Dec only (season ±1 month)', o.sim_months.every((m: number) => [10, 11, 12].includes(m)), o.sim_months)
      add('10g. similar days are all rainy', JSON.stringify(o.sim_weather) === JSON.stringify(['雨']), o.sim_weather)
      add('10h. day type from CSV agrees with jpholiday (except year-end 12/29-1/3)', o.daytype_mismatches_outside_yearend.length === 0, { outsideYearEnd: o.daytype_mismatches_outside_yearend, raw祝Differences: o.holiday_mismatches })
      add('10i. unknown item returns no_data', o.unknown_item_no_data === true, o.unknown_item_no_data)
    }
    const b1 = await runPython(shopId, BACKTEST)
    const b2 = await runPython(shopId, BACKTEST)
    if (!b1.ok || !b2.ok) {
      add('9. backtest runs', false, (b1.ok ? b2 : b1).output.trim().split('\n').slice(-2).join(' | '))
    } else {
      const x = JSON.parse(b1.output.trim().split('\n').pop() ?? '{}')
      const y = JSON.parse(b2.output.trim().split('\n').pop() ?? '{}')
      const ind = actualWasteLastDays(30)
      add('9a. backtest gives the same result twice', JSON.stringify(x) === JSON.stringify(y), { net1: x.netSaving, net2: y.netSaving })
      add('9b. backtest period is the last 30 days', x.from === ind.from && x.to === ind.to, { backtest: [x.from, x.to], independent: [ind.from, ind.to] })
      add('9c. actual waste cost matches independent count', x.actualWasteCost === ind.cost, { backtest: x.actualWasteCost, independent: ind.cost })
      add('9d. net = actual - simulated - lost sales', x.netSaving === x.actualWasteCost - x.simWasteCost - x.lostSales, x)
    }
  } catch (err) {
    add('test setup', false, (err as Error).message)
  } finally {
    await deleteAllSandboxes()
  }
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  -> ${c.detail}`)
  const failed = checks.filter((c) => !c.ok).length
  console.log(failed ? `\n${failed} FAILED` : `\nALL ${checks.length} PASSED`)
  process.exit(failed ? 1 : 0)
}

void main()
