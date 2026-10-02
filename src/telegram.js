import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate-limited send queue. If alerts pile up beyond maxQueue, the smallest
// trades are dropped and summarised in one line.
export class TelegramQueue {
  constructor() {
    this.items = [];
    this.running = false;
    this.dropped = 0;
    this.url = `https://api.telegram.org/bot${config.telegramToken}/sendMessage`;
  }

  push(text, weight = 0) {
    this.items.push({ text, weight });
    if (this.items.length > config.maxQueue) {
      let smallest = 0;
      this.items.forEach((it, i) => {
        if (it.weight < this.items[smallest].weight) smallest = i;
      });
      this.items.splice(smallest, 1);
      this.dropped++;
    }
    if (!this.running) this.loop();
  }

  async loop() {
    this.running = true;
    while (this.items.length) {
      await this.deliver(this.items.shift().text);
      await sleep(config.sendIntervalMs);
    }
    if (this.dropped) {
      await this.deliver(`⚠️ ${this.dropped} smaller trades skipped (high activity)`);
      this.dropped = 0;
    }
    this.running = false;
  }

  async deliver(text) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });
        if (res.ok) {
          console.log('Telegram: alert sent');
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (res.status === 429) {
          await sleep(((body.parameters?.retry_after ?? 5) + 1) * 1000);
          continue;
        }
        console.error('Telegram error:', res.status, body.description);
        return;
      } catch (e) {
        console.error('Telegram fetch failed:', e.message);
        await sleep(2000);
      }
    }
  }
}
