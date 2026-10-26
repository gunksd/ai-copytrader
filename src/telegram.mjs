// Telegram: notifications + /status /buy /sell. Only the configured chat is obeyed.
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function createTelegram({ cfg, state, saveState, log }) {
  const T = cfg.telegram;
  const enabled = !!(T.enabled && T.token && T.chatId);
  const api = (m) => `https://api.telegram.org/bot${T.token}/${m}`;

  async function send(text) {
    if (!enabled) return;
    const chunks = [];
    for (let s = String(text ?? ''); s.length; s = s.slice(3800)) chunks.push(s.slice(0, 3800));
    for (const part of chunks) {
      try {
        const r = await fetch(api('sendMessage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: T.chatId, text: part, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15_000),
        });
        const j = await r.json().catch(() => null);
        if (j && j.ok === false) console.error('tg_send_failed', j.description);
      } catch (e) { console.error('tg_send_failed', e.message); }
    }
  }

  // commands: { status(): Promise<string>, buy(token, bnb), sell(token, pct) }
  async function loop(commands) {
    if (!enabled) return;
    let offset = Number(state.tgOffset) || 0;
    if (!offset) {
      // First start: skip whatever is already queued so old /buy are not replayed.
      try {
        const j = await (await fetch(api('getUpdates?offset=-1&limit=1'), { signal: AbortSignal.timeout(15_000) })).json();
        const last = j?.result?.at(-1);
        if (last) offset = last.update_id + 1;
      } catch { /* retry in loop */ }
    }
    let errAt = 0;
    for (;;) {
      try {
        const j = await (await fetch(api(`getUpdates?timeout=25&offset=${offset}`), { signal: AbortSignal.timeout(35_000) })).json();
        for (const u of j?.result || []) {
          offset = u.update_id + 1;
          state.tgOffset = offset;
          const msg = u.message;
          if (!msg || String(msg.chat?.id) !== String(T.chatId)) continue;
          const text = String(msg.text || '').trim().replace(/@\S+/, '');
          void handle(text, commands).catch((e) => send(`❌ ${e.message}`));
        }
        if (j?.result?.length) saveState();
      } catch (e) {
        if (Date.now() - errAt > 60_000) { errAt = Date.now(); log('tg_poll_error', { message: e.message }); }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async function handle(text, commands) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (cmd === '/status') return send(await commands.status());
    if (cmd === '/buy') {
      const token = parts[1];
      const bnb = Number(parts[2]);
      if (!ADDR_RE.test(token || '') || !(bnb > 0)) return send('用法:/buy <代币地址> <BNB 数量>\n例:/buy 0xabc… 0.01');
      await send(`⏳ 买入 ${token} ${bnb} BNB …`);
      return send(await commands.buy(token.toLowerCase(), bnb));
    }
    if (cmd === '/sell') {
      const token = parts[1];
      const pct = Number(String(parts[2] || '').replace('%', ''));
      if (!ADDR_RE.test(token || '') || !(pct > 0 && pct <= 100)) return send('用法:/sell <代币地址> <百分比>\n例:/sell 0xabc… 50');
      await send(`⏳ 卖出 ${token} ${pct}% …`);
      return send(await commands.sell(token.toLowerCase(), pct));
    }
    return send('/status 运行状态\n/buy <地址> <BNB> 买入(优先用记录过的路由,没有就走聚合器)\n/sell <地址> <百分比> 卖出');
  }

  return { enabled, send, loop };
}
