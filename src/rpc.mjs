// HTTP JSON-RPC pool: sticky healthy endpoint, failover on network errors,
// batch requests, per-request timeout. Contract reverts are NOT failovers.
export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function createRpc(endpoints, { timeoutMs = 8000, onError = () => {} } = {}) {
  const urls = endpoints.slice();
  let sticky = 0;
  let id = 0;

  async function post(body, timeout) {
    let lastErr;
    for (let k = 0; k < urls.length; k++) {
      const idx = (sticky + k) % urls.length;
      try {
        const res = await fetch(urls[idx], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok && res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        // Rate limits come back as JSON errors on some providers: fail over.
        // Same for "archive requires a token" style refusals (publicnode on older blocks).
        const rate = (x) => x?.error && /rate.?limit|too many requests|over capacity|archive|personal token|missing trie node|header not found/i.test(String(x.error.message || ''));
        if (Array.isArray(j) ? j.some(rate) : rate(j)) throw new Error(`refused: ${String((Array.isArray(j) ? j.find(rate) : j).error.message).slice(0, 80)}`);
        if (k > 0) sticky = idx;
        return j;
      } catch (e) {
        lastErr = e;
        onError(urls[idx], e);
      }
    }
    throw lastErr || new Error('all RPC endpoints failed');
  }

  async function rpc(method, params = [], { timeout = timeoutMs } = {}) {
    const j = await post({ jsonrpc: '2.0', id: ++id, method, params }, timeout);
    if (j.error) throw new RpcError(`${method}: ${j.error.message}`, j.error.code, j.error.data);
    return j.result;
  }

  // Returns [{ result } | { error }] in input order.
  async function batch(items, { timeout = timeoutMs } = {}) {
    if (!items.length) return [];
    const base = id;
    id += items.length;
    const payload = items.map((it, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: it.method, params: it.params }));
    const j = await post(payload, timeout);
    const arr = Array.isArray(j) ? j : [j];
    const byId = new Map(arr.map((x) => [x.id, x]));
    return items.map((_, i) => {
      const x = byId.get(base + i + 1);
      if (!x) return { error: { message: 'missing batch response' } };
      return x.error ? { error: x.error } : { result: x.result };
    });
  }

  return { rpc, batch, urls };
}
