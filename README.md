# LossLens 🥐

**POS shows what you sold. LossLens shows what you threw away.**

LossLens is an AI waste analyst for small food shops. The shop uploads its sales CSV once, then asks questions in Japanese or English in a chat.

[日本語は下にあります](#日本語)

## How it works

1. **Upload a CSV.** The shop gets its own private [Daytona](https://www.daytona.io/) sandbox with pandas, matplotlib and jpholiday. The server keeps one sandbox ready, so the upload takes about 2 seconds.
2. **Ask a question.** Claude (`claude-sonnet-5-5`) writes pandas code. The code runs in the shop's sandbox, and Claude answers from the real result. It never guesses numbers.
3. **See the answer.** You get the answer, a table, a chart, and a "Show the work" panel with the exact pandas code that ran.

Coming next: a forecast for tomorrow that uses [Tavily](https://tavily.com/) for weather and local events, and a 30-day backtest.

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
2. Click 「先月はいくら捨てた?去年の同じ月と比べて?」 (How much did we waste last month, compared with the same month last year?)
   → October 2026: ¥97,050. October 2025: ¥120,230. That is about 19% less.
3. Click 「雨の日に一番ロスが多い商品は?」 (Which item loses the most on rainy days?)
   → Sandwich (¥175,040 over 134 rainy days), with a bar chart. Open "Show the work" to see the pandas code.
4. Click 「明日メロンパンは何個焼くべき?」 (How many melon pans should we bake tomorrow?) *(coming next)*

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

## Files

| File | What it does |
|---|---|
| `server.ts` | Express server: `/api/upload`, `/api/chat`, and cleanup on shutdown |
| `agent.ts` | Claude agent loop, system prompt and tools |
| `tools.ts` | Daytona sandboxes (one per shop, plus one spare) and `run_python` |
| `public/index.html` | The web page (one file, no build step) |
| `bakery_sales_sample.csv` | Sample data: 8 items, 2025-09-01 to 2026-11-13 |

---

## 日本語

**POSは「売れたもの」を見せる。LossLensは「捨てたもの」を見せる。**

LossLensは、小さな食品店のためのAIロス分析ツールです。売上CSVを一度アップロードすれば、あとはチャットで日本語または英語で質問できます。

### しくみ

1. **CSVをアップロード** — お店ごとに専用の[Daytona](https://www.daytona.io/)サンドボックスを作ります。pandas・matplotlib・jpholidayが入っています。サーバーは予備のサンドボックスを1つ用意しているので、アップロードは約2秒で終わります。
2. **質問する** — Claude(`claude-sonnet-5-5`)がpandasのコードを書きます。コードはお店のサンドボックスで実行され、Claudeはその結果から答えます。数字を推測することはありません。
3. **答えを見る** — 回答・表・グラフが表示されます。「Show the work」を開くと、実際に動いたpandasのコードを確認できます。

今後の予定:[Tavily](https://tavily.com/)で天気と地域のイベントを調べる「明日の製造数の提案」と、過去30日のバックテスト。

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
   → サンドイッチ(雨の日134日で175,040円)。棒グラフも出ます。「Show the work」でpandasのコードを確認できます。
4. 「明日メロンパンは何個焼くべき?」をクリック *(近日対応)*

### CSVの形式

UTF-8(BOM付きでも可)。1行は「1日 × 1商品」です。列は英語版の表と同じです。

ロス額 = `wasted × unit_cost_yen`
