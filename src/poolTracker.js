import { EventEmitter } from "node:events";
import { config } from "./config.js";

const ZERO_HASH = "0".repeat(64);
const REORDER_MS = config.reorderWindowMs ?? 700; // collect updates this long before applying them
const ORPHAN_WAIT_MS = config.orphanWaitMs ?? 5000; // how long to wait for a missing earlier update

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
    this.spent = new Set(); // utxo hashes already spent, so late/out-of-order updates can't re-add them
    this.buffers = new Map(); // tokenId -> updates waiting to be applied in order
    this.timers = new Map(); // tokenId -> drain timer
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
        if (u.is_withdrawn) continue;
        this.spent.delete(u.new_utxo_hash); // fresh snapshot is the truth
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

  // Updates are buffered per token for a short window, then applied in chain order
  // (each pool update spends the previous one), so trades that arrive out of order
  // are still read correctly and shown one by one, oldest first.
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
    for (const u of utxos) {
      if (!this.ready.has(u.token_id)) continue;
      const list = this.buffers.get(u.token_id) ?? [];
      list.push({ u, at: Date.now() });
      this.buffers.set(u.token_id, list);
      this.scheduleDrain(u.token_id, REORDER_MS);
    }
  }

  scheduleDrain(tokenId, ms) {
    if (this.timers.has(tokenId)) return;
    this.timers.set(
      tokenId,
      setTimeout(() => {
        this.timers.delete(tokenId);
        this.drain(tokenId);
      }, ms),
    );
  }

  drain(tokenId) {
    const state = this.pools.get(tokenId);
    let items = this.buffers.get(tokenId) ?? [];
    this.buffers.delete(tokenId);
    if (!state || !this.ready.has(tokenId)) return;

    const known = (u) =>
      u.spent_utxo_hash === ZERO_HASH || state.has(u.spent_utxo_hash);
    const duplicate = (u) =>
      !known(u) &&
      (state.has(u.new_utxo_hash) || this.spent.has(u.new_utxo_hash));

    // apply whatever has its parent pool state, repeat until nothing more can be placed
    let progress = true;
    while (items.length && progress) {
      progress = false;
      const rest = [];
      for (const it of items) {
        if (known(it.u)) {
          this.apply(tokenId, state, it.u);
          progress = true;
        } else if (duplicate(it.u)) {
          progress = true; // repeat notification (e.g. on confirmation), already applied
        } else {
          rest.push(it);
        }
      }
      items = rest;
    }

    // still missing their parent: wait a few seconds for it, then apply without a trade
    const now = Date.now();
    const waiting = [];
    for (const it of items) {
      if (now - it.at >= ORPHAN_WAIT_MS) this.apply(tokenId, state, it.u);
      else waiting.push(it);
    }
    if (waiting.length) {
      this.buffers.set(
        tokenId,
        waiting.concat(this.buffers.get(tokenId) ?? []),
      );
      this.scheduleDrain(tokenId, REORDER_MS);
    }
  }

  apply(tokenId, state, u) {
    const old = state.get(u.spent_utxo_hash);
    const txid = u.new_utxo_txid;

    if (old && !u.is_withdrawn && !this.seen.has(txid)) {
      const dSats = u.sats - old.sats;
      const dTokens = u.token_amount - old.tokens;
      const side =
        dSats > 0 && dTokens < 0
          ? "buy"
          : dSats < 0 && dTokens > 0
            ? "sell"
            : null;
      if (side) {
        let agg = this.pending.get(txid);
        if (!agg) {
          agg = {
            tokenId,
            txid,
            priceBefore: this.snapshot(tokenId).price, // before this tx touches the state
            buy: { sats: 0, tokens: 0 },
            sell: { sats: 0, tokens: 0 },
            timer: null,
          };
          this.pending.set(txid, agg);
        }
        agg[side].sats += Math.abs(dSats);
        agg[side].tokens += Math.abs(dTokens);
        clearTimeout(agg.timer);
        agg.timer = setTimeout(() => this.flush(txid), config.batchWindowMs);
      }
    }

    if (u.spent_utxo_hash !== ZERO_HASH) {
      state.delete(u.spent_utxo_hash);
      this.spent.add(u.spent_utxo_hash);
      if (this.spent.size > 20000)
        this.spent.delete(this.spent.values().next().value);
    }
    if (!u.is_withdrawn && !this.spent.has(u.new_utxo_hash)) {
      state.set(u.new_utxo_hash, { sats: u.sats, tokens: u.token_amount });
    }
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
