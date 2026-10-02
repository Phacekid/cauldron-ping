import { EventEmitter } from "node:events";
import WebSocket from "ws";

// Minimal Electrum-style JSON-RPC client over WebSocket with auto-reconnect.
// Emits: 'open', 'notification' ({method, params}), 'close'
export class RostrumClient extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.retry = 0;
    this.isOpen = false;
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on("open", async () => {
      this.retry = 0;
      try {
        await this.request("server.version", ["CauldronPing", "1.4"]);
      } catch (e) {
        console.warn("server.version failed:", e.message);
      }
      clearInterval(this.pinger);
      this.pinger = setInterval(
        () => this.request("server.ping").catch(() => {}),
        60_000,
      );
      this.isOpen = true;
      this.emit("open");
    });

    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error
          ? reject(new Error(JSON.stringify(msg.error)))
          : resolve(msg.result);
      } else if (msg.method) {
        this.emit("notification", msg);
      }
    });

    const onDown = () => {
      this.isOpen = false;
      clearInterval(this.pinger);
      for (const { reject } of this.pending.values())
        reject(new Error("socket closed"));
      this.pending.clear();
      this.emit("close");
      const delay = Math.min(30_000, 1000 * 2 ** this.retry++);
      console.warn(`Rostrum disconnected, reconnecting in ${delay / 1000}s`);
      setTimeout(() => this.connect(), delay);
    };
    this.ws.once("close", onDown);
    this.ws.on("error", (e) => console.warn("Rostrum error:", e.message));
  }

  request(method, params = []) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN)
        return reject(new Error("socket not open"));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 20_000);
    });
  }
}
