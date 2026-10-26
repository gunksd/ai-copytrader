// Block source: WSS newHeads subscription (Node built-in WebSocket) with
// reconnect + backoff, plus an HTTP polling fallback that kicks in whenever no
// head has arrived for `stallMs`. Blocks are delivered in order, exactly once.
export function createHeadSource({ wssUrls = [], rpc, pollMs = 1000, stallMs = 3000, log = () => {}, onBlock }) {
  let last = null;            // highest block number delivered
  let lastHeadAt = 0;         // last time WSS gave us a head
  let wsConnected = false;
  let stopped = false;
  let ws = null;
  let wsIdx = 0;
  let backoff = 1000;
  let queue = Promise.resolve();
  let pollTimer = null;

  // Serialize delivery so blocks are handled in order even when WSS and the
  // poller race each other.
  function deliverUpTo(head, source) {
    queue = queue.then(async () => {
      if (stopped) return;
      if (last === null) last = head - 1;
      // Never replay a huge gap after a long outage: cap catch-up at 50 blocks.
      if (head - last > 50) {
        log('heads_gap_skipped', { from: last + 1, to: head - 51 });
        last = head - 51;
      }
      for (let b = last + 1; b <= head; b++) {
        try {
          await onBlock(b, source);
        } catch (e) {
          log('error', { where: 'onBlock', block: b, message: e.message });
        }
        last = b;
      }
    });
    return queue;
  }

  function connect() {
    if (stopped || !wssUrls.length || typeof WebSocket === 'undefined') return;
    const url = wssUrls[wsIdx % wssUrls.length];
    let subId = null;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log('wss_error', { url, message: e.message });
      return scheduleReconnect();
    }
    const openTimer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } }, 10_000);
    ws.onopen = () => {
      clearTimeout(openTimer);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    };
    ws.onmessage = (ev) => {
      let j;
      try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (j.id === 1 && j.result) {
        subId = j.result;
        wsConnected = true;
        backoff = 1000;
        log('wss_subscribed', { url });
        return;
      }
      if (j.method === 'eth_subscription' && j.params?.subscription === subId) {
        const n = Number(j.params.result?.number);
        if (!Number.isFinite(n)) return;
        lastHeadAt = Date.now();
        if (last === null || n > last) deliverUpTo(n, 'wss');
      }
    };
    ws.onerror = (e) => { log('wss_error', { url, message: e?.message || 'error' }); };
    ws.onclose = () => {
      clearTimeout(openTimer);
      if (wsConnected) log('wss_closed', { url });
      wsConnected = false;
      ws = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (stopped) return;
    wsIdx++;
    const d = backoff;
    backoff = Math.min(backoff * 2, 30_000);
    setTimeout(connect, d);
  }

  async function pollOnce() {
    if (stopped) return;
    const stale = !wsConnected || Date.now() - lastHeadAt > stallMs;
    if (stale) {
      try {
        const n = Number(await rpc('eth_blockNumber'));
        if (Number.isFinite(n) && (last === null || n > last)) await deliverUpTo(n, 'poll');
      } catch (e) {
        log('poll_error', { message: e.message });
      }
    }
    pollTimer = setTimeout(pollOnce, pollMs);
  }

  return {
    start(fromBlock = null) {
      if (fromBlock != null) last = fromBlock - 1;
      connect();
      pollOnce();
    },
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
    get lastBlock() { return last; },
    get connected() { return wsConnected; },
  };
}
