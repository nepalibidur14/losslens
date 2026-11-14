import Anthropic from '@anthropic-ai/sdk'
import { CHART_PATH, CSV_PATH, runPython } from './tools'

const MODEL = 'claude-sonnet-5-5'
const MAX_ITERATIONS = 6

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (!client) client = new Anthropic()
  return client
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string }
/** One tool call, shown in the UI "Show the work" panel. */
export type Step = { tool: string; input: string; output: string; ok: boolean; ms: number }
export type AgentResult = { answer: string; chartBase64?: string; toolsUsed: string[]; steps: Step[] }

const STEP_OUTPUT_CHARS = 3000

function todayTokyo(): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date())
}

function systemPrompt(): string {
  return `You are LossLens, a food-waste analyst for a small bakery. Rules:
- Never guess numbers. Every number about the shop must come from running pandas code via run_python on ${CSV_PATH}.
- Answer in the user's language (Japanese or English). Show money in yen with commas.
- For "how many to make tomorrow" questions:
  1) call get_tomorrow_context for weather and events, 2) check holiday with jpholiday in run_python,
  3) find SIMILAR past days (same day type weekday/weekend-or-holiday, same weather, same season ±1 month) for that item,
  4) suggest a RANGE (not one number) based on sold counts on similar days (e.g. 25th–75th percentile of total sold),
  5) show a factor table: Day type | Weather | Holiday | Local events | Similar past days (count, avg sold, avg wasted) | Today's usual batch,
  6) estimate the daily saving in yen versus the usual batch size.
- If an item has no history in the data, say clearly "no past data for this item" and do not invent numbers.
- Forecasts are guidance, not guarantees; facts (totals, comparisons) are exact.
- Keep answers short: headline first, then the table, then 1–2 lines of evidence.

Data facts:
- Today is ${todayTokyo()} (Asia/Tokyo). "Last month" means the full previous calendar month.
- Read the data with: pd.read_csv('${CSV_PATH}', encoding='utf-8-sig')
- Columns: date (YYYY-MM-DD), weekday (月..日), holiday ("祝" or empty -> NaN in pandas), weather (晴れ/曇り/雨), item, price_yen, unit_cost_yen, made, sold_full_price, sold_half_price, wasted.
- One row per item per day. Total sold = sold_full_price + sold_half_price.
- Waste cost = wasted * unit_cost_yen. Half-price lost revenue = sold_half_price * price_yen * 0.5.
- Each run_python call is a fresh Python process: load the CSV every time. Print only the small result you need (no full dataframes).

Charts:
- When the answer compares items, months, weather or day types (rankings, "which item loses most", month vs month), also save ONE simple bar chart in the same run_python call: plt.savefig('${CHART_PATH}', dpi=110, bbox_inches='tight'). Do not make a chart for single-number answers.
- No Japanese font is installed: all chart text must be English. Item names: メロンパン=Melon pan, クロワッサン=Croissant, あんパン=Anpan, カレーパン=Curry bread, 食パン(1斤)=Shokupan loaf, 塩パン=Salt bread, チョコデニッシュ=Choco danish, サンドイッチ=Sandwich (romanize any other item). Weather: 晴れ=Sunny, 曇り=Cloudy, 雨=Rainy.
- Title the chart clearly, label the y-axis with the unit (e.g. "Waste cost (yen)"), and write the value on top of each bar.
- The chart is shown to the user automatically under your answer; do not mention the file path.`
}

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: 'run_python',
    description:
      `Run Python 3 code (pandas, matplotlib, jpholiday are installed) in this shop's private Daytona sandbox and return its stdout. ` +
      `The sales data is at ${CSV_PATH} (UTF-8 with BOM: use encoding='utf-8-sig'). Use print() to output results. ` +
      `If the code raises an error you get the traceback back: fix the code and call again.`,
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Complete Python script to run.' } },
      required: ['code'],
      additionalProperties: false,
    },
    strict: true,
  },
]

function sanitizeHistory(history: unknown): Anthropic.Beta.BetaMessageParam[] {
  if (!Array.isArray(history)) return []
  const turns = history
    .filter(
      (t): t is ChatTurn =>
        !!t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim() !== '',
    )
    .slice(-10)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }))
  // The conversation must start with a user turn.
  while (turns.length && turns[0].role !== 'user') turns.shift()
  return turns
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export async function runAgent(shopId: string, message: string, history: unknown): Promise<AgentResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [...sanitizeHistory(history), { role: 'user', content: message }]
  const toolsUsed = new Set<string>()
  const steps: Step[] = []
  let chartBase64: string | undefined
  const t0 = Date.now()
  console.log(`[agent] question: ${message.slice(0, 120)}`)

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const isLast = i === MAX_ITERATIONS
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: systemPrompt(),
      tools: TOOLS,
      // On the last allowed round, force a text answer with what we have.
      ...(isLast ? { tool_choice: { type: 'none' as const } } : {}),
      messages,
    })
    console.log(`[agent] round ${i}: stop_reason=${response.stop_reason} (${Date.now() - t0} ms)`)

    if (response.stop_reason === 'refusal') {
      return { answer: 'Sorry, I cannot help with that request.', chartBase64, toolsUsed: [...toolsUsed], steps }
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content })
      continue
    }
    if (response.stop_reason !== 'tool_use') {
      // end_turn, max_tokens, stop_sequence: return what Claude wrote.
      const answer = textOf(response.content) || 'Sorry, I could not produce an answer. Please try again.'
      console.log(`[agent] done in ${i} round(s), ${Date.now() - t0} ms, tools: ${[...toolsUsed].join(',') || 'none'}`)
      return { answer, chartBase64, toolsUsed: [...toolsUsed], steps }
    }

    // Keep the full assistant content (thinking + tool_use blocks) unchanged.
    messages.push({ role: 'assistant', content: response.content })
    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        if (tu.name === 'run_python') {
          toolsUsed.add('daytona')
          const code = typeof (tu.input as { code?: unknown })?.code === 'string' ? (tu.input as { code: string }).code : ''
          if (!code) return { type: 'tool_result', tool_use_id: tu.id, content: 'Missing "code".', is_error: true }
          const started = Date.now()
          const r = await runPython(shopId, code)
          if (r.chartBase64) chartBase64 = r.chartBase64
          steps.push({ tool: 'run_python', input: code, output: r.output.slice(0, STEP_OUTPUT_CHARS), ok: r.ok, ms: Date.now() - started })
          return { type: 'tool_result', tool_use_id: tu.id, content: r.output, is_error: !r.ok }
        }
        return { type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool: ${tu.name}`, is_error: true }
      }),
    )
    messages.push({ role: 'user', content: results })
  }

  return {
    answer: 'Sorry, this question needed too many steps. Please ask a simpler question.',
    chartBase64,
    toolsUsed: [...toolsUsed],
    steps,
  }
}

/** Turn an SDK error into a short message for the UI. */
export function friendlyError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The AI key is not valid. Check ANTHROPIC_API_KEY in .env.'
  if (err instanceof Anthropic.RateLimitError) return 'The AI is busy right now. Please wait a few seconds and try again.'
  if (err instanceof Anthropic.BadRequestError) return 'The AI could not read this request. Please try a different question.'
  if (err instanceof Anthropic.APIError) return 'The AI service had a problem. Please try again.'
  return 'Something went wrong. Please try again.'
}
