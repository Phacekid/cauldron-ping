import { config } from "./config.js";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k]);

const fmt = (n, max = 2) =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: max });

const fmtBch = (sats) =>
  (sats / 1e8).toFixed(sats >= 1e6 ? 4 : 8).replace(/\.?0+$/, "");

// USD for normal amounts: 2 decimals above $1, more below.
const fmtUsd = (usd) => {
  const digits = usd >= 1 ? 2 : usd >= 0.01 ? 4 : 6;
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: digits })}`;
};

// USD for token prices, which can be tiny: keep 4 significant digits, no exponent.
const fmtPriceUsd = (usd) => {
  if (usd >= 1)
    return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const decimals = Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(usd))));
  return `$${usd.toFixed(decimals).replace(/0+$/, "")}`;
};

function tier(side, bch) {
  if (bch >= config.whaleTradeBch) return "🐋";
  const dot = side === "buy" ? "🟢" : "🔴";
  return bch >= config.bigTradeBch ? dot.repeat(3) : dot;
}

export function formatTrade(t, bchUsd) {
  const { token, side, sats, txid } = t;
  const dec = 10 ** token.decimals;
  const bch = sats / 1e8;
  const amount = t.tokens / dec;
  const priceSats = t.priceAfter * dec; // sats per whole token
  const impact =
    t.priceBefore > 0 ? (t.priceAfter / t.priceBefore - 1) * 100 : 0;
  const sym = esc(token.symbol);

  const usdOf = (satsVal) => (bchUsd ? (satsVal / 1e8) * bchUsd : null);
  const inBrackets = (usd) => (usd === null ? "" : ` (${fmtUsd(usd)})`);

  const priceUsd = usdOf(priceSats);
  const priceLine =
    priceUsd !== null ? fmtPriceUsd(priceUsd) : `${fmt(priceSats, 2)} sats`;

  // TVL in USD only; falls back to BCH if no USD price is available
  const tvlUsd = usdOf(t.tvlBch * 1e8);
  const tvlLine = tvlUsd !== null ? fmtUsd(tvlUsd) : `${fmt(t.tvlBch, 3)} BCH`;

  const txUrl = fill(config.explorerTxUrl, { txid });
  const tokenUrl = fill(config.tokenUrl, { id: token.id });

  return [
    `${tier(side, bch)} <b>${side === "buy" ? "BUY" : "SELL"}</b> · <b>$${sym}</b>`,
    `💰 ${side === "buy" ? "Spent" : "Received"}: <b>${fmtBch(sats)} BCH</b>${inBrackets(usdOf(sats))}`,
    `🪙 ${side === "buy" ? "Got" : "Sold"}: ${fmt(amount)} ${sym}`,
    `💲 Price: ${priceLine}`,
    `${impact >= 0 ? "📈" : "📉"} Impact: ${impact >= 0 ? "+" : ""}${impact.toFixed(2)}%`,
    `📊 TVL: ${tvlLine}`,
    `🔗 <a href="${txUrl}">Tx</a> · <a href="${tokenUrl}">Swap</a>`,
  ].join("\n");
}
