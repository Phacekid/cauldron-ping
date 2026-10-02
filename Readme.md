# CauldronPing

Real-time Telegram alerts for buys and sells on [Cauldron](https://cauldron.quest), the Bitcoin Cash DEX. Watches every token above a TVL threshold and posts one compact message per trade to a Telegram group or channel.

```
🟢🟢🟢 BUY · $TOKEN
💰 Spent: 0.85 BCH ($382.50)
🪙 Got: 4,600 TOKEN
💲 Price: $0.1542
📈 Impact: +2.43%
📊 TVL: $1,665.00
🔗 Tx · Swap
```

## Features

- Real-time alerts from mempool activity, no polling delay
- Buy and sell detection for any token above a TVL threshold (default 0.05 BCH)
- Minimum trade size filter to cut spam
- Size tiers: 🟢/🔴 small, 🟢🟢🟢/🔴🔴🔴 big, 🐋 whale
- Token price and TVL in USD, trade value in BCH with USD in brackets
- Price impact of each trade
- One alert per transaction, even when a swap routes through several pools
- Token symbol and decimals resolved automatically from the BCMR registry
- BCH/USD price from 9 fallback sources
- Rate-limited Telegram queue (stays under the ~20 messages/min limit)
- Auto-reconnect, periodic token list refresh, and a JSONL trade log

## Requirements

- Node.js 18 or newer
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- The bot added to your group (or as an **admin** of your channel, with "Post messages")

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create your config:
   ```bash
   cp .env.example .env
   ```
3. Fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.
4. Start:
   ```bash
   npm start
   ```

On start the console prints "CauldronPing started" and "Watching N tokens". Nothing is posted to Telegram until the first qualifying trade.

### Getting the chat ID

Add the bot to your group or channel, post a message there, then open:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Look for `"chat":{"id":-100...}`. Group and channel IDs are negative. A public channel can also use its `@username`.

## Configuration

All settings live in `.env`.

| Variable                | Default                                | Description                                                                           |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`    | required                               | Bot token from BotFather                                                              |
| `TELEGRAM_CHAT_ID`      | required                               | Target group or channel ID                                                            |
| `MIN_TVL_BCH`           | `0.05`                                 | Ignore tokens with TVL below this                                                     |
| `MIN_TRADE_BCH`         | `0.01`                                 | Ignore trades smaller than this                                                       |
| `TVL_DOUBLE_BCH_SIDE`   | `true`                                 | Count the BCH side twice (Riften's TVL method). `false` uses the raw BCH side         |
| `MAX_TOKENS`            | `0`                                    | Number of top-TVL tokens to watch. `0` watches every token Cauldron lists             |
| `MAX_CONNECTIONS`       | `4`                                    | Most Rostrum connections the bot may open                                             |
| `TOKENS_PER_CONNECTION` | `0`                                    | Cap per connection. `0` fills each one until the server reports its limit             |
| `BIG_TRADE_BCH`         | `1`                                    | Trades at or above this get the 🟢🟢🟢 / 🔴🔴🔴 tier                                  |
| `WHALE_TRADE_BCH`       | `5`                                    | Trades at or above this get 🐋                                                        |
| `REFRESH_MS`            | `300000`                               | How often the watched token list is refreshed                                         |
| `BCH_USD_FALLBACK`      | none                                   | BCH price used only if no live price source has ever worked                           |
| `INDEXER_URL`           | Riften indexer                         | Cauldron indexer REST base URL                                                        |
| `ROSTRUM_URL`           | `wss://rostrum.riften.net:443`         | Rostrum WebSocket server                                                              |
| `BCMR_URL`              | `https://bcmr.paytaca.com/api/tokens`  | Token metadata registry                                                               |
| `EXPLORER_TX_URL`       | `https://bchexplorer.info/tx/{txid}`   | Transaction link template                                                             |
| `TOKEN_URL`             | `https://app.cauldron.quest/swap/{id}` | Swap link template                                                                    |
| `DEBUG`                 | off                                    | Set `1` to log every pool update, ignored liquidity changes, and the sample token row |
| `LOG_FILE`              | `data/trades.jsonl`                    | Where alerts are logged                                                               |

## How it works

1. `cauldronApi.js` fetches every listed token from the Riften indexer (sorted by TVL). The console prints how many tokens Cauldron lists, and again whenever that number changes, then fills in missing symbols and decimals from the BCMR registry. Tokens with no registry entry show a short token ID and use 0 decimals.
2. `poolTracker.js` subscribes to each token with `cauldron.contract.subscribe` over Rostrum and keeps the state of every active pool.
3. When a pool changes:
   - pool BCH up and tokens down means a **buy**
   - pool BCH down and tokens up means a **sell**
   - both moving the same direction is a liquidity change and is ignored
4. Updates sharing a transaction ID are merged into one trade after a short window.
5. Trades that pass the TVL and size filters are formatted by `format.js` and sent through the queue in `telegram.js`.
6. `price.js` supplies BCH/USD (cached for 60s). It tries the last working source first, then CoinGecko, Coinbase, Kraken, CryptoCompare, Binance, OKX, Bitstamp, CoinPaprika and Blockchair. If none work, it uses the last known price, then `BCH_USD_FALLBACK`. With no USD price at all, alerts show sats and BCH instead.

## Project structure

```
src/
├── index.js          entry point, wires modules together
├── config.js         environment settings
├── cauldronApi.js    token list and metadata lookup
├── rostrumClient.js  WebSocket client with reconnect
├── poolTracker.js    pool state and trade detection
├── format.js         Telegram message builder
├── telegram.js       rate-limited send queue
└── price.js          BCH/USD price with fallbacks
```

## Troubleshooting

- **Alerts not reaching Telegram:** the console prints `Telegram: alert sent` on success, or the error from Telegram. Check `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and that the bot can post (admin for channels).
- **Nothing is being alerted:** a `[heartbeat]` line prints every 5 minutes with updates received, trades detected and trades skipped by filters. Skipped trades also print their reason. For a quick test, set `MIN_TVL_BCH=0`, `MIN_TRADE_BCH=0` and `DEBUG=1` for a few minutes.
- **Symbols show as short IDs:** the token has no BCMR entry, or the registry response differed from what the code expects. Run with `DEBUG=1` to see failed lookups.
- **Price sources failing:** each failing source is reported once with its reason, such as `ENOTFOUND` or `ETIMEDOUT`. If many report `fetch failed`, try forcing IPv4:
  ```bash
  node --dns-result-order=ipv4first src/index.js
  ```
  Windows PowerShell:
  ```powershell
  $env:NODE_OPTIONS="--dns-result-order=ipv4first"; npm start
  ```
  Set `BCH_USD_FALLBACK` so alerts always show USD.

## Known limits

- **No trader wallet.** The feed exposes the pool owner, not the trader, so wallets are not shown.
- **Subscription cap.** Rostrum limits subscriptions per connection. The bot opens extra connections (up to `MAX_CONNECTIONS`) when one is full. If the log says the limit was reached on all connections, raise `MAX_CONNECTIONS` or lower `MAX_TOKENS`.
- **Mempool alerts.** Alerts fire on unconfirmed transactions, so a rare double spend could produce an alert for a trade that never confirms.
- **Failed sends are not retried** beyond Telegram's rate-limit waits, so an alert sent while the bot lacks permission is lost.
- **Indexer response shape.** The `/tokens/list_cached` format isn't fully documented. If symbols or decimals are wrong for registered tokens, adjust the field mapping in `cauldronApi.js`.

## Running in the background

With [pm2](https://pm2.keymetrics.io/):

```bash
npm i -g pm2
pm2 start src/index.js --name cauldron-ping
pm2 save
```

## Data sources

- [Riften Labs Cauldron indexer API](https://docs.riftenlabs.com/cauldron/API/cauldron/)
- [Cauldron contract subscribe (Rostrum)](https://docs.riftenlabs.com/cauldron/API/contract-subscribe/)
- Paytaca BCMR indexer for token metadata
- CoinGecko and other public APIs for BCH/USD

## Disclaimer

Alerts are informational only and not financial advice. Data comes from third-party indexers and may be delayed or wrong.
