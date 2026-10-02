import { EventEmitter } from "node:events";
import { config } from "./config.js";

const ZERO_HASH = "0".repeat(64);

// Tracks every active pool of each watched token (via cauldron.contract.subscribe)
// and turns pool state changes into buy/sell events.
//
// Pool sats up + tokens down  => someone BOUGHT tokens with BCH
// Pool sats down + tokens up  => someone SOLD tokens for BCH
// Both up/down together       => liquidity add/remove, ignored
export class PoolTracker extends EventEmitter {
  constructor(rostrum) {
    super();
    this.rostrum = rostrum;
    this.tokens = new Map(); // id -> meta
    this.pools = new Map(); // tokenId -> Map(utxoHash -> {sats, tokens})
    this.ready = new Set(); // tokens whose initial state is loaded
    this.pending = new Map(); // txid -> aggregation while we wait for sibling updates
    this.seen = new Set(); // txids already emitted
    this.limitHit = false;
    this.stats = { updates: 0, trades: 0 };

    rostrum.on("notification", (msg) => {
      if (msg.method === "cauldron.contract.subscribe")
        this.onUpdate(msg.params);
    });
    // a connection closed: its subscriptions are gone, the next refresh re-subscribes
    rostrum.on("dropped", (ids) => this.drop(ids));
  }

  drop(ids) {
    for (const id of ids) {
      this.tokens.delete(id);
      this.pools.delete(id);
      this.ready.delete(id);
    }
    this.limitHit = false;
  }

  reset() {
    this.pools.clear();
    this.ready.clear();
    this.tokens.clear();
    this.limitHit = false;
  }

  async syncTokens(list) {
    const wanted = new Map(list.map((t) => [t.id, t]));

    for (const id of [...this.tokens.keys()]) {
      if (!wanted.has(id)) {
        this.rostrum.unsubscribe(id).catch(() => {});
        this.tokens.delete(id);
        this.pools.delete(id);
        this.ready.delete(id);
      }
    }

    const fresh = list.filter((t) => !this.tokens.has(t.id));
    for (let i = 0; i < fresh.length && !this.limitHit; i += 5) {
      await Promise.all(fresh.slice(i, i + 5).map((t) => this.subscribe(t)));
    }
    console.log(
      `Watching ${this.ready.size} tokens on ${this.rostrum.connectionCount} connection(s)`,
    );
  }

  async subscribe(token) {
    try {
      const res = await this.rostrum.subscribe(token.id);
      this.tokens.set(token.id, token);
      const state = new Map();
      for (const u of res?.utxos ?? []) {
        if (!u.is_withdrawn)
          state.set(u.new_utxo_hash, { sats: u.sats, tokens: u.token_amount });
      }
      this.pools.set(token.id, state);
      this.ready.add(token.id);
    } catch (e) {
      if (e.code === "LIMIT") {
        this.limitHit = true;
        console.warn(e.message);
      } else {
        console.warn(`Subscribe failed for ${token.symbol}:`, e.message);
      }
    }
  }

  snapshot(tokenId) {
    let sats = 0;
    let tokens = 0;
    for (const p of this.pools.get(tokenId)?.values() ?? []) {
      sats += p.sats;
      tokens += p.tokens;
    }
    return { sats, tokens, price: tokens > 0 ? sats / tokens : 0 };
  }

  onUpdate(params) {
    const utxos = params?.utxos ?? [];
    this.stats.updates++;
    if (config.debug) {
      console.log(
        "[debug] update",
        utxos
          .map(
            (u) =>
              `${this.tokens.get(u.token_id)?.symbol ?? u.token_id.slice(0, 6)} ${u.sats}sats/${u.token_amount}tok${u.is_withdrawn ? " withdrawn" : ""}`,
          )
          .join(" | "),
      );
    }

    // 1) capture old values of spent pools before touching state
    const olds = utxos.map((u) =>
      this.pools.get(u.token_id)?.get(u.spent_utxo_hash),
    );

    // 2) make sure we know the pre-trade price for each tx
    utxos.forEach((u) => {
      if (!this.ready.has(u.token_id) || this.seen.has(u.new_utxo_txid)) return;
      if (!this.pending.has(u.new_utxo_txid)) {
        const before = this.snapshot(u.token_id);
        this.pending.set(u.new_utxo_txid, {
          tokenId: u.token_id,
          txid: u.new_utxo_txid,
          priceBefore: before.price,
          buy: { sats: 0, tokens: 0 },
          sell: { sats: 0, tokens: 0 },
          timer: null,
        });
      }
    });

    // 3) add new utxos, then 4) remove spent ones (server order is not topological)
    for (const u of utxos) {
      const state = this.pools.get(u.token_id);
      if (state && !u.is_withdrawn) {
        state.set(u.new_utxo_hash, { sats: u.sats, tokens: u.token_amount });
      }
    }
    for (const u of utxos) {
      if (u.spent_utxo_hash !== ZERO_HASH)
        this.pools.get(u.token_id)?.delete(u.spent_utxo_hash);
    }

    // 5) classify each changed pool
    utxos.forEach((u, i) => {
      const old = olds[i];
      const agg = this.pending.get(u.new_utxo_txid);
      if (!old || !agg || u.is_withdrawn) return;

      const dSats = u.sats - old.sats;
      const dTokens = u.token_amount - old.tokens;
      if (dSats > 0 && dTokens < 0) {
        agg.buy.sats += dSats;
        agg.buy.tokens += -dTokens;
      } else if (dSats < 0 && dTokens > 0) {
        agg.sell.sats += -dSats;
        agg.sell.tokens += dTokens;
      }
      clearTimeout(agg.timer);
      agg.timer = setTimeout(() => this.flush(agg.txid), config.batchWindowMs);
    });
  }

  flush(txid) {
    const agg = this.pending.get(txid);
    this.pending.delete(txid);
    if (!agg || this.seen.has(txid)) return;

    const side = agg.buy.sats >= agg.sell.sats ? "buy" : "sell";
    const leg = agg[side];
    if (leg.sats === 0) {
      if (config.debug)
        console.log("[debug] liquidity change, ignored", txid.slice(0, 8));
      return; // liquidity event only
    }

    this.seen.add(txid);
    if (this.seen.size > 5000)
      this.seen.delete(this.seen.values().next().value);

    const after = this.snapshot(agg.tokenId);
    const token = this.tokens.get(agg.tokenId);
    const bchSide = after.sats / 1e8;

    this.stats.trades++;
    this.emit("trade", {
      token,
      side,
      txid,
      sats: leg.sats,
      tokens: leg.tokens,
      priceBefore: agg.priceBefore,
      priceAfter: after.price,
      tvlBch: config.tvlDoubleBchSide ? bchSide * 2 : bchSide,
    });
  }
}
