# LossLens 🥐

**POS shows what you sold. LossLens shows what you threw away.**

LossLens is an AI waste analyst for small food shops. The shop uploads its sales CSV once, then asks questions in English or Japanese in a chat. Answers use plain, everyday words, not technical terms.

The page is in English by default. The button at the top right switches the whole page to Japanese.

[日本語は下にあります](#日本語)

## How it works

1. **Upload a CSV.** The shop gets its own private [Daytona](https://www.daytona.io/) sandbox with pandas, matplotlib and jpholiday. The server keeps one sandbox ready, so the upload takes about 2 seconds.
2. **Ask a question.** Claude (`claude-sonnet-5-5`) writes pandas code. The code runs in the shop's sandbox, and Claude answers from the real result. It never guesses numbers.
3. **See the answer.** You get the answer, a table, a chart, and a "Show the work" panel with the exact pandas code that ran.
4. **Plan tomorrow.** For "how many should I bake tomorrow?", [Tavily](https://tavily.com/) finds tomorrow's weather and local events. A fixed Python helper (`losslens.py`) then checks Japanese holidays with jpholiday, finds similar past days (same day type, same weather, ±1 month) and suggests a range, not one number.
5. **Backtest.** After the upload, the same helper replays the last 30 days: "following LossLens would have saved ¥X". It is a fixed script, so the number is the same on every run.

## Run it

Tested with Node.js 24.

```sh
npm install
cp .env.example .env
```

Put your keys in `.env`, then start the server:

```sh
npx tsx server.ts
```

Open http://localhost:4000. To stop, press Ctrl+C. This also deletes all the sandboxes.

To get a public URL for a demo (needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)):

```sh
cloudflared tunnel --url http://localhost:4000
```

The URL changes every time you start the tunnel.

## Environment variables

| Name | What it is for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API |
| `DAYTONA_API_KEY` | Daytona sandboxes |
| `TAVILY_API_KEY` | Tavily web search |
| `PORT` | Server port (default `4000`) |

## Demo script

1. Upload `bakery_sales_sample.csv`.
2. Click "How much did we waste last month vs the same month last year?" (Japanese: 「先月はいくら捨てた?去年の同じ月と比べて?」)
   → October 2026: ¥97,050. October 2025: ¥120,230. That is about 19% less.
3. Click "Which item loses the most on rainy days?" (Japanese: 「雨の日に一番ロスが多い商品は?」)
   → Sandwich, with a bar chart: ¥175,040 thrown away over 134 rainy days (¥208,220 if you add the half-price discounts). Open "Show the work" to see the pandas code.
4. Click "How many melon pans should we bake tomorrow?" (Japanese: 「明日メロンパンは何個焼くべき?」)
   → A range, the estimated saving per day, and a factor table. Both badges show (Daytona + Tavily), with links to the weather and event sources. On 2026-11-14 (rain forecast for Sunday 11/15) it said **34–36**, versus the usual batch of 53, saving about ¥803 a day.
5. Look at the backtest card under the upload: the last 30 days (2026-10-15 → 2026-11-13) → **¥25,570** net saving (waste −¥34,010, lost sales −¥8,440).

## CSV format

UTF-8 (a BOM is OK). One row per item per day.

| Column | Example |
|---|---|
| `date` | `2026-10-01` |
| `weekday` | `月` … `日` |
| `holiday` | `祝`, or empty |
| `weather` | `晴れ` / `曇り` / `雨` |
| `item` | `メロンパン` |
| `price_yen`, `unit_cost_yen` | `180`, `55` |
| `made`, `sold_full_price`, `sold_half_price`, `wasted` | `42`, `40`, `0`, `2` |

Waste cost = `wasted × unit_cost_yen`.

## Test

```sh
npx tsx test.ts
```

This creates a real Daytona sandbox, runs the fixed helper, and deletes the sandbox at the end. It checks that Sunday 2026-11-15 counts as a weekend, that the day type from the CSV matches jpholiday (except year-end, 12/29–1/3), that an unknown item returns "no data", and that the backtest gives the same number twice and matches an independent count. Expect `ALL 13 PASSED`.

## Files

| File | What it does |
|---|---|
| `server.ts` | Express server: `/api/upload`, `/api/chat`, `/api/backtest`, and cleanup on shutdown |
| `agent.ts` | Claude agent loop, system prompt and tools |
| `tools.ts` | Daytona sandboxes (one per shop, plus one spare), `run_python`, Tavily search, backtest |
| `losslens.py` | Fixed Python helper (day type, similar days, suggestion, backtest), uploaded to each sandbox |
| `test.ts` | Test for the helper, run in a real sandbox |
| `public/index.html` | The web page (one file, no build step) |
| `bakery_sales_sample.csv` | Sample data: 8 items, 2025-09-01 to 2026-11-13 |

---

## 日本語

**POSは「売れたもの」を見せる。LossLensは「捨てたもの」を見せる。**

LossLensは、小さな食品店のためのAIロス分析ツールです。売上CSVを一度アップロードすれば、あとはチャットで日本語または英語で質問できます。答えは専門用語を使わず、わかりやすい言葉で返します。

画面は最初は英語です。右上のボタンで、ページ全体を日本語に切り替えられます。

### しくみ

1. **CSVをアップロード** — お店ごとに専用の[Daytona](https://www.daytona.io/)サンドボックスを作ります。pandas・matplotlib・jpholidayが入っています。サーバーは予備のサンドボックスを1つ用意しているので、アップロードは約2秒で終わります。
2. **質問する** — Claude(`claude-sonnet-5-5`)がpandasのコードを書きます。コードはお店のサンドボックスで実行され、Claudeはその結果から答えます。数字を推測することはありません。
3. **答えを見る** — 回答・表・グラフが表示されます。「計算の中身を見る」を開くと、実際に動いたpandasのコードを確認できます。
4. **明日の計画** — 「明日何個焼くべき?」には、[Tavily](https://tavily.com/)で明日の天気と地域のイベントを調べます。そのあと固定のPythonヘルパー(`losslens.py`)が、jpholidayで祝日を確認し、似た過去の日(同じ曜日区分・同じ天気・前後1か月)を探して、1つの数ではなく「範囲」で提案します。
5. **バックテスト** — アップロード後、同じヘルパーで過去30日を再現し、「LossLensに従っていたら¥Xの節約」と表示します。固定のスクリプトなので、毎回同じ数字になります。

### 起動方法

Node.js 24で動作を確認しています。

```sh
npm install
cp .env.example .env
```

`.env` にキーを入れてから、サーバーを起動します。

```sh
npx tsx server.ts
```

http://localhost:4000 を開きます。止めるときは Ctrl+C を押してください。サンドボックスもすべて削除されます。

デモ用の公開URLを作るとき([cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) が必要):

```sh
cloudflared tunnel --url http://localhost:4000
```

URLは起動するたびに変わります。

### 環境変数

| 名前 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API |
| `DAYTONA_API_KEY` | Daytonaサンドボックス |
| `TAVILY_API_KEY` | Tavily Web検索 |
| `PORT` | サーバーのポート(初期値 `4000`) |

### デモの流れ

1. `bakery_sales_sample.csv` をアップロードします。
2. 「先月はいくら捨てた?去年の同じ月と比べて?」をクリック
   → 2026年10月は97,050円、2025年10月は120,230円。約19%減りました。
3. 「雨の日に一番ロスが多い商品は?」をクリック
   → サンドイッチ。棒グラフも出ます。雨の日134日の廃棄は175,040円(半額値引きを足すと208,220円)。「計算の中身を見る」でpandasのコードを確認できます。
4. 「明日メロンパンは何個焼くべき?」をクリック
   → おすすめの範囲、1日あたりの節約額、要因の表が出ます。DaytonaとTavilyの両方のバッジと、天気・イベントの出典リンクも表示されます。2026-11-14(翌日11/15日曜は雨の予報)には **34〜36個**(いつもは53個、1日約803円の節約)と提案しました。
5. アップロード欄の下のバックテスト:過去30日(2026-10-15 → 2026-11-13)で **25,570円** の節約(ロス −34,010円、売り逃し −8,440円)。

### CSVの形式

UTF-8(BOM付きでも可)。1行は「1日 × 1商品」です。列は英語版の表と同じです。

ロス額 = `wasted × unit_cost_yen`

### テスト

```sh
npx tsx test.ts
```

本物のDaytonaサンドボックスを作ってヘルパーを実行し、最後に削除します。`ALL 13 PASSED` と出れば成功です。
