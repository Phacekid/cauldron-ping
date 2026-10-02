import { EventEmitter } from "node:events";
import { RostrumClient } from "./rostrumClient.js";
import { config } from "./config.js";

const isLimitError = (e) => /limit|too many|exceed/i.test(e.message);

function waitOpen(client) {
  if (client.isOpen) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      client.off("open", done);
      reject(new Error("connection timeout"));
    }, 15_000);
    client.once("open", done);
  });
}

// Spreads token subscriptions over several Rostrum connections.
// A connection is filled until the server reports its subscription limit
// (or TOKENS_PER_CONNECTION is reached), then the next one is opened,
// up to MAX_CONNECTIONS. No need to know the server's limit in advance.
//
// Emits: 'open' (a connection became ready), 'notification',
//        'dropped' (token ids whose connection closed)
export class RostrumPool extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.slots = [];
    this.growing = null;
  }

  start() {
    this.addSlot();
  }

  get connectionCount() {
    return this.slots.filter((s) => s.client.isOpen).length;
  }

  addSlot() {
    const client = new RostrumClient(this.url);
    const slot = { client, tokens: new Set(), full: false };
    client.on("notification", (m) => this.emit("notification", m));
    client.on("open", () => this.emit("open"));
    client.on("close", () => {
      const ids = [...slot.tokens];
      slot.tokens.clear();
      slot.full = false;
      if (ids.length) this.emit("dropped", ids);
    });
    this.slots.push(slot);
    client.connect();
    return slot;
  }

  hasRoom(slot) {
    return (
      !slot.full &&
      (!config.tokensPerConnection ||
        slot.tokens.size < config.tokensPerConnection)
    );
  }

  // Wait for a connecting slot, or open a new one if allowed. Shared between concurrent callers.
  grow() {
    if (!this.growing) {
      this.growing = (async () => {
        let slot = this.slots.find((s) => !s.client.isOpen && this.hasRoom(s));
        if (!slot) {
          if (this.slots.length >= config.maxConnections) return null;
          console.log(
            `Opening Rostrum connection ${this.slots.length + 1}/${config.maxConnections}`,
          );
          slot = this.addSlot();
        }
        await waitOpen(slot.client);
        return slot;
      })().finally(() => {
        this.growing = null;
      });
    }
    return this.growing;
  }

  async subscribe(tokenId) {
    for (;;) {
      let slot = this.slots.find((s) => s.client.isOpen && this.hasRoom(s));
      if (!slot) slot = await this.grow();
      if (!slot) {
        const err = new Error(
          `Subscription limit reached on all ${this.slots.length} connections. Lower MAX_TOKENS or raise MAX_CONNECTIONS`,
        );
        err.code = "LIMIT";
        throw err;
      }

      slot.tokens.add(tokenId); // reserve before awaiting so parallel calls see it
      try {
        return await slot.client.request("cauldron.contract.subscribe", [
          2,
          tokenId,
        ]);
      } catch (e) {
        slot.tokens.delete(tokenId);
        if (!isLimitError(e)) throw e;
        if (!slot.full)
          console.log(`Connection full at ${slot.tokens.size} tokens`);
        slot.full = true;
      }
    }
  }

  async unsubscribe(tokenId) {
    const slot = this.slots.find((s) => s.tokens.has(tokenId));
    if (!slot) return;
    slot.tokens.delete(tokenId);
    slot.full = false;
    await slot.client
      .request("cauldron.contract.unsubscribe", [2, tokenId])
      .catch(() => {});
  }
}
