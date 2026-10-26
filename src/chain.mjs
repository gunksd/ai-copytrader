// Chain constants and read helpers (ERC20 reads, block receipts, eth_simulateV1).
import { padAddr, W } from './route.mjs';

export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Tokens a target pays with / receives on a sell. Everything else is "the token".
export const QUOTES = new Map([
  [NATIVE, 'BNB'],
  [WBNB, 'WBNB'],
  ['0x55d398326f99059ff775485246999027b3197955', 'USDT'],
  ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 'USDC'],
  ['0xe9e7cea3dedca5984780bafc599bd69add087d56', 'BUSD'],
  ['0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', 'USD1'],
  ['0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', 'FDUSD'],
]);
export const isQuote = (t) => QUOTES.has(String(t).toLowerCase());
export const topicAddr = (t) => '0x' + String(t).slice(26).toLowerCase();
export const hexNum = (n) => '0x' + BigInt(n).toString(16);

export function createChain({ rpc, batch, log = () => {} }) {
  const decCache = new Map([[NATIVE, 18]]);
  const symCache = new Map([[NATIVE, 'BNB']]);
  let simSupported = null; // null = unknown, then true/false

  async function call(to, data, block = 'latest') {
    try { return await rpc('eth_call', [{ to, data }, block]); } catch { return null; }
  }

  async function balanceOf(token, owner, block = 'latest') {
    if (token === NATIVE) return BigInt(await rpc('eth_getBalance', [owner, block]));
    const r = await call(token, '0x70a08231' + padAddr(owner), block);
    if (!r || r === '0x') return null;
    try { return BigInt(r.slice(0, 66)); } catch { return null; }
  }

  async function allowance(token, owner, spender) {
    const r = await call(token, '0xdd62ed3e' + padAddr(owner) + padAddr(spender));
    if (!r || r === '0x') return 0n;
    try { return BigInt(r.slice(0, 66)); } catch { return 0n; }
  }

  async function decimals(token) {
    const t = String(token).toLowerCase();
    if (decCache.has(t)) return decCache.get(t);
    const r = await call(t, '0x313ce567');
    const d = r && r !== '0x' ? Number(BigInt(r.slice(0, 66))) : 18;
    decCache.set(t, d);
    return d;
  }

  async function symbol(token) {
    const t = String(token).toLowerCase();
    if (symCache.has(t)) return symCache.get(t);
    if (QUOTES.has(t)) { symCache.set(t, QUOTES.get(t)); return QUOTES.get(t); }
    let s = t.slice(0, 8);
    const r = await call(t, '0x95d89b41');
    try {
      if (r && r.length >= 130) {
        const len = Number(BigInt('0x' + r.slice(66, 130)));
        s = Buffer.from(r.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/[^\x20-\x7e一-鿿]/g, '') || s;
      } else if (r && r.length === 66) {
        s = Buffer.from(r.slice(2), 'hex').toString('utf8').replace(/\0/g, '') || s;
      }
    } catch { /* keep fallback */ }
    symCache.set(t, s);
    return s;
  }

  async function isContract(addr) {
    try { const c = await rpc('eth_getCode', [addr, 'latest']); return !!c && c !== '0x'; } catch { return false; }
  }

  // Receipts for a whole block in one request; null result usually means the
  // HTTP node has not caught up with the WSS head yet, so retry briefly.
  async function blockReceipts(n) {
    for (let i = 0; i < 6; i++) {
      try {
        const r = await rpc('eth_getBlockReceipts', [hexNum(n)]);
        if (Array.isArray(r)) return r;
      } catch (e) {
        if (/not supported|does not exist|method not found/i.test(e.message)) return blockReceiptsSlow(n);
      }
      await new Promise((res) => setTimeout(res, 150 + i * 150));
    }
    return blockReceiptsSlow(n);
  }

  async function blockReceiptsSlow(n) {
    const blk = await rpc('eth_getBlockByNumber', [hexNum(n), false]);
    if (!blk?.transactions?.length) return [];
    const res = await batch(blk.transactions.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    return res.map((x) => x.result).filter(Boolean);
  }

  /**
   * Simulate calls from `from` with eth_simulateV1 (traceTransfers on), one
   * independent simulation per call, all in one HTTP batch. `prelude` calls
   * (e.g. an approve) run first in the same block; only the last call counts.
   * Returns per call { ok, error, gain: Map(asset -> net raw for `from`) }
   * or null when the RPC does not support eth_simulateV1.
   */
  async function simulate(from, calls, { nativeBalance = null, prelude = [] } = {}) {
    if (simSupported === false || !calls.length) return null;
    const me = from.toLowerCase();
    const items = calls.map((c) => {
      const block = {
        calls: [
          ...prelude.map((p) => ({ from: me, to: p.to, value: hexNum(p.value || 0n), data: p.data })),
          { from: me, to: c.to, value: hexNum(c.value || 0n), data: c.data },
        ],
      };
      if (nativeBalance != null) block.stateOverrides = { [me]: { balance: hexNum(nativeBalance) } };
      return { method: 'eth_simulateV1', params: [{ blockStateCalls: [block], traceTransfers: true, validation: false }, 'latest'] };
    });
    let res;
    try {
      res = await batch(items, { timeout: 6000 });
    } catch (e) {
      log('simulate_error', { message: e.message });
      return null;
    }
    if (res.every((r) => r.error && /not supported|does not exist|method not found|unknown method/i.test(String(r.error.message)))) {
      simSupported = false;
      log('simulate_unsupported', {});
      return null;
    }
    simSupported = true;
    return res.map((r) => {
      if (r.error) return { ok: false, error: r.error.message, gain: new Map() };
      const all = r.result?.[0]?.calls || [];
      const c = all[all.length - 1];
      if (!c) return { ok: false, error: 'empty simulation', gain: new Map() };
      const badPrelude = all.slice(0, -1).find((p) => p.status !== '0x1');
      if (badPrelude) return { ok: false, error: `prelude reverted: ${badPrelude.error?.message || ''}`, gain: new Map() };
      if (c.status !== '0x1') return { ok: false, error: c.error?.message || 'reverted', gain: new Map() };
      const gain = new Map();
      for (const l of c.logs || []) {
        if (l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
        const asset = String(l.address).toLowerCase();
        let v;
        try { v = BigInt(l.data); } catch { continue; }
        if (topicAddr(l.topics[2]) === me) gain.set(asset, (gain.get(asset) || 0n) + v);
        if (topicAddr(l.topics[1]) === me) gain.set(asset, (gain.get(asset) || 0n) - v);
      }
      return { ok: true, error: null, gain };
    });
  }

  async function waitReceipt(hash, tries = 30) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await rpc('eth_getTransactionReceipt', [hash]);
        if (r?.blockNumber) return r;
      } catch { /* keep polling */ }
      await new Promise((res) => setTimeout(res, i < 8 ? 500 : i < 16 ? 1000 : 3000));
    }
    return null;
  }

  return { rpc, batch, call, balanceOf, allowance, decimals, symbol, isContract, blockReceipts, simulate, waitReceipt, W };
}

export const fmtUnits = (raw, dec, digits = 6) => {
  const n = Number(BigInt(raw)) / 10 ** dec;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
};

export function parseUnits(s, dec) {
  const [i, f = ''] = String(s).trim().split('.');
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) throw new Error(`数量格式不对:${s}`);
  return BigInt((i || '0') + (f + '0'.repeat(dec)).slice(0, dec));
}

export function rawToDecimal(raw, dec) {
  const s = BigInt(raw).toString().padStart(dec + 1, '0');
  const int = s.slice(0, s.length - dec);
  const frac = s.slice(s.length - dec).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
