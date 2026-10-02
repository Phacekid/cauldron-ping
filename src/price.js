let cache = { usd: null, at: 0 };
let preferred = null; // name of the last source that worked
const warned = new Set(); // sources already reported as failing

const SOURCES = [
  [
    "CoinGecko",
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd",
    (j) => j["bitcoin-cash"]?.usd,
  ],
  [
    "Coinbase",
    "https://api.coinbase.com/v2/prices/BCH-USD/spot",
    (j) => j.data?.amount,
  ],
  [
    "Kraken",
    "https://api.kraken.com/0/public/Ticker?pair=BCHUSD",
    (j) => Object.values(j.result ?? {})[0]?.c?.[0],
  ],
  [
    "CryptoCompare",
    "https://min-api.cryptocompare.com/data/price?fsym=BCH&tsyms=USD",
    (j) => j.USD,
  ],
  [
    "Binance",
    "https://api.binance.com/api/v3/ticker/price?symbol=BCHUSDT",
    (j) => j.price,
  ],
  [
    "OKX",
    "https://www.okx.com/api/v5/market/ticker?instId=BCH-USDT",
    (j) => j.data?.[0]?.last,
  ],
  ["Bitstamp", "https://www.bitstamp.net/api/v2/ticker/bchusd/", (j) => j.last],
  [
    "CoinPaprika",
    "https://api.coinpaprika.com/v1/tickers/bch-bitcoin-cash",
    (j) => j.quotes?.USD?.price,
  ],
  [
    "Blockchair",
    "https://api.blockchair.com/bitcoin-cash/stats",
    (j) => j.data?.market_price_usd,
  ],
];

const reason = (e) =>
  `${e.message}${e.cause?.code ? ` (${e.cause.code})` : ""}`;

// BCH/USD with fallback sources, cached for 60s. The last working source is tried
// first, and each failing source is reported only once until it works again.
// If every source fails it uses the last known price, then BCH_USD_FALLBACK from .env.
export async function getBchUsd() {
  if (Date.now() - cache.at < 60_000) return cache.usd;

  const ordered = [...SOURCES].sort(
    (a, b) => (b[0] === preferred) - (a[0] === preferred),
  );

  for (const [name, url, pick] of ordered) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const json = await res.json();
      const usd = Number(pick(json));
      if (!Number.isFinite(usd) || usd <= 0) {
        throw new Error(
          `no price in response: ${JSON.stringify(json).slice(0, 80)}`,
        );
      }
      cache = { usd, at: Date.now() };
      preferred = name;
      warned.delete(name);
      return usd;
    } catch (e) {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`BCH price via ${name} failed: ${reason(e)}`);
      }
    }
  }

  cache.at = Date.now() - 50_000; // all failed, retry in ~10s
  const fallback = Number(process.env.BCH_USD_FALLBACK);
  return cache.usd ?? (fallback > 0 ? fallback : null);
}
