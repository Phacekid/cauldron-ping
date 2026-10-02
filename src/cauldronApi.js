import { config } from "./config.js";

const BCMR_URL = process.env.BCMR_URL || "https://bcmr.paytaca.com/api/tokens";
const metaCache = new Map(); // id -> {symbol, name, decimals}
const noMeta = new Set(); // ids with no registry entry, not retried until restart
const LIST_LIMIT = 1000; // ask for the full list so the total can be reported
let lastTotal = null;

// Tokens from the Riften indexer, sorted by TVL (highest first).
// `limit` 0 (the MAX_TOKENS default) means every listed token.
// Logs how many tokens Cauldron lists at start and whenever that number changes.
// Symbol/decimals are read if present, and filled in later by enrichTokens().
export async function fetchTopTokens(limit = config.maxTokens) {
  const url = `${config.indexerUrl}/tokens/list_cached?limit=${LIST_LIMIT}&by=tvl&order=desc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Indexer ${res.status} for ${url}`);
  const rows = await res.json();
  if (config.debug && rows[0])
    console.log("[debug] sample token row:", JSON.stringify(rows[0]));

  const watched = limit > 0 ? rows.slice(0, limit) : rows;

  if (rows.length !== lastTotal) {
    const was = lastTotal === null ? "" : ` (was ${lastTotal})`;
    const total = rows.length >= LIST_LIMIT ? `${LIST_LIMIT}+` : rows.length;
    const scope =
      watched.length === rows.length
        ? "watching all"
        : `watching the top ${watched.length} by TVL (MAX_TOKENS=${limit}, set 0 for all)`;
    console.log(`Cauldron lists ${total} tokens${was}, ${scope}`);
    lastTotal = rows.length;
  }

  return watched
    .map((r) => ({
      id: r.token_id ?? r.id ?? r.category,
      symbol: r.symbol ?? r.ticker ?? r.token?.symbol ?? null,
      name: r.name ?? "",
      decimals: r.decimals ?? r.token?.decimals ?? null,
    }))
    .filter((t) => t.id);
}

async function fetchBcmr(id) {
  const res = await fetch(`${BCMR_URL}/${id}/`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`BCMR ${res.status}`);
  const d = await res.json();
  return {
    symbol: d.token?.symbol ?? d.symbol ?? null,
    name: d.name ?? "",
    decimals: d.token?.decimals ?? d.decimals ?? null,
  };
}

// Fills missing symbol/decimals from the BCMR registry (Paytaca indexer).
// Tokens with no registry entry fall back to a short id and 0 decimals.
export async function enrichTokens(tokens) {
  const todo = tokens.filter(
    (t) => (!t.symbol || t.decimals == null) && !noMeta.has(t.id),
  );

  for (let i = 0; i < todo.length; i += 10) {
    await Promise.all(
      todo.slice(i, i + 10).map(async (t) => {
        let meta = metaCache.get(t.id);
        if (!meta) {
          try {
            meta = await fetchBcmr(t.id);
            metaCache.set(t.id, meta);
          } catch (e) {
            noMeta.add(t.id);
            if (config.debug)
              console.log(
                `[debug] no BCMR for ${t.id.slice(0, 8)}: ${e.message}`,
              );
            return;
          }
        }
        t.symbol = t.symbol ?? meta.symbol;
        t.name = t.name || meta.name;
        t.decimals = t.decimals ?? meta.decimals;
      }),
    );
  }

  for (const t of tokens) {
    const cached = metaCache.get(t.id);
    t.symbol = t.symbol ?? cached?.symbol ?? t.id.slice(0, 6);
    t.decimals = Number(t.decimals ?? cached?.decimals ?? 0);
  }
  return tokens;
}
