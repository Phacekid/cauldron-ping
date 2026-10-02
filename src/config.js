import "dotenv/config";

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,

  indexerUrl: process.env.INDEXER_URL || "https://indexer.riften.net/cauldron",
  rostrumUrl: process.env.ROSTRUM_URL || "wss://rostrum.riften.net:443",

  minTvlBch: num(process.env.MIN_TVL_BCH, 0.05),
  minTradeBch: num(process.env.MIN_TRADE_BCH, 0.01),
  tvlDoubleBchSide: process.env.TVL_DOUBLE_BCH_SIDE !== "false",
  maxTokens: num(process.env.MAX_TOKENS, 0), // 0 = watch every token Cauldron lists

  // Rostrum connections: tokens are spread across them when one hits its subscription limit
  maxConnections: num(process.env.MAX_CONNECTIONS, 4),
  tokensPerConnection: num(process.env.TOKENS_PER_CONNECTION, 0), // 0 = fill until the server says full

  bigTradeBch: num(process.env.BIG_TRADE_BCH, 1),
  whaleTradeBch: num(process.env.WHALE_TRADE_BCH, 5),

  refreshMs: num(process.env.REFRESH_MS, 5 * 60 * 1000),
  batchWindowMs: 1500, // wait for all pool updates of one tx before alerting
  sendIntervalMs: 3200, // ~18 msgs/min, under Telegram's 20/min group limit
  maxQueue: 30,

  explorerTxUrl:
    process.env.EXPLORER_TX_URL || "https://bchexplorer.info/tx/{txid}",
  tokenUrl: process.env.TOKEN_URL || "https://app.cauldron.quest/swap/{id}",
  debug: process.env.DEBUG === "1",
  logFile: process.env.LOG_FILE || "data/trades.jsonl",
};

export function assertConfig() {
  if (!config.telegramToken || !config.chatId) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
    process.exit(1);
  }
}
