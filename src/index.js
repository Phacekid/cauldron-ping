import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config, assertConfig } from "./config.js";
import { fetchTopTokens, enrichTokens } from "./cauldronApi.js";
import { RostrumPool } from "./rostrumPool.js";
import { PoolTracker } from "./poolTracker.js";
import { TelegramQueue } from "./telegram.js";
import { formatTrade } from "./format.js";
import { getBchUsd } from "./price.js";

assertConfig();
await mkdir(dirname(config.logFile), { recursive: true });

const rostrum = new RostrumPool(config.rostrumUrl);
const tracker = new PoolTracker(rostrum);
const telegram = new TelegramQueue();

let filtered = 0;

tracker.on("trade", async (t) => {
  const bch = t.sats / 1e8;
  if (t.tvlBch < config.minTvlBch || bch < config.minTradeBch) {
    filtered++;
    console.log(
      `Skipped ${t.side} ${t.token.symbol}: trade ${bch.toFixed(4)} BCH, TVL ${t.tvlBch.toFixed(3)} BCH`,
    );
    return;
  }

  console.log(
    `${t.side.toUpperCase()} ${t.token.symbol} ${bch.toFixed(4)} BCH (${t.txid.slice(0, 8)}…)`,
  );
  appendFile(
    config.logFile,
    JSON.stringify({
      time: Date.now(),
      ...t,
      token: t.token.id,
      symbol: t.token.symbol,
    }) + "\n",
  ).catch(() => {});

  const usd = await getBchUsd();
  telegram.push(formatTrade(t, usd), t.sats);
});

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await tracker.syncTokens(await enrichTokens(await fetchTopTokens()));
  } catch (e) {
    console.error("Token refresh failed:", e.message);
  } finally {
    refreshing = false;
  }
}

rostrum.on("open", refresh); // a (re)connected socket needs its tokens subscribed
setInterval(refresh, config.refreshMs);

setInterval(
  () => {
    console.log(
      `[heartbeat] watching=${tracker.ready.size} updates=${tracker.stats.updates} trades=${tracker.stats.trades} skipped=${filtered}`,
    );
  },
  5 * 60 * 1000,
);

rostrum.start();
console.log("CauldronPing started");
