// Platform-agnostic action detection: look only at the target's net token
// flows in the receipt. Spent a quote (BNB / WBNB / stable) and received a
// token X => BUY X. Spent token X and received a quote (or BNB) => SELL X.
import { NATIVE, TRANSFER, isQuote, topicAddr } from './chain.mjs';

const PLAIN_SELECTORS = new Set([
  '0xa9059cbb', // transfer
  '0x23b872dd', // transferFrom
  '0x095ea7b3', // approve
  '0x39509351', // increaseAllowance
]);

/**
 * @param {object} tx       { from, to, value, input }
 * @param {object} receipt  { status, logs }
 * @param {bigint|null} nativeIn  BNB the target received in this tx (internal
 *                         transfers are invisible in logs), null if unknown
 * @returns {{kind:'buy'|'sell'|'none', reason?:string, token?:string,
 *            spent?:{token:string, raw:bigint}, received?:{token:string, raw:bigint}}}
 */
export function detectAction(tx, receipt, nativeIn = null) {
  if (!receipt || receipt.status !== '0x1') return { kind: 'none', reason: '交易失败或未上链' };
  const sel = String(tx.input || '0x').slice(0, 10).toLowerCase();
  if (PLAIN_SELECTORS.has(sel)) return { kind: 'none', reason: '普通转账/授权,不是交易' };
  const who = String(tx.from).toLowerCase();
  const out = new Map();
  const inn = new Map();
  for (const l of receipt.logs || []) {
    if (l.topics?.[0] !== TRANSFER || l.topics.length !== 3) continue; // ERC721 has 4 topics
    if (!l.data || l.data === '0x') continue;
    let raw;
    try { raw = BigInt(l.data.slice(0, 66)); } catch { continue; }
    if (raw === 0n) continue;
    const token = String(l.address).toLowerCase();
    const from = topicAddr(l.topics[1]);
    const to = topicAddr(l.topics[2]);
    if (from === who && to !== who) out.set(token, (out.get(token) || 0n) + raw);
    if (to === who && from !== who) inn.set(token, (inn.get(token) || 0n) + raw);
  }
  // Net out round-trips (e.g. a refund of the same token).
  for (const [t, v] of inn) {
    if (out.has(t)) {
      const o = out.get(t);
      if (o >= v) { out.set(t, o - v); inn.delete(t); } else { inn.set(t, v - o); out.delete(t); }
    }
  }
  for (const m of [out, inn]) for (const [t, v] of m) if (v === 0n) m.delete(t);

  const largest = (m, pred) => {
    let best = null;
    for (const [token, raw] of m) if (pred(token) && (!best || raw > best.raw)) best = { token, raw };
    return best;
  };
  const value = BigInt(tx.value || '0x0');
  const gotToken = largest(inn, (t) => !isQuote(t));
  const soldToken = largest(out, (t) => !isQuote(t));

  // BUY: paid BNB (msg.value) or an ERC20 quote, received a non-quote token.
  if (gotToken && !soldToken) {
    const spent = value > 0n ? { token: NATIVE, raw: value } : largest(out, isQuote);
    if (!spent) return { kind: 'none', reason: '收到代币但没有付出计价币(空投/领取)', token: gotToken.token };
    return { kind: 'buy', token: gotToken.token, spent, received: gotToken };
  }
  // SELL: gave a non-quote token, got a quote back (ERC20 or native BNB).
  if (soldToken && !gotToken) {
    let received = largest(inn, isQuote);
    if (!received && nativeIn != null && nativeIn > 0n) received = { token: NATIVE, raw: nativeIn };
    if (!received && nativeIn == null && value === 0n) {
      // Native refund unknown (state pruned): treat as a BNB sell, the
      // plain-transfer selectors were already excluded above.
      received = { token: NATIVE, raw: 0n };
    }
    if (!received) return { kind: 'none', reason: '只转出代币,没有收到计价币(可能是转账)', token: soldToken.token };
    return { kind: 'sell', token: soldToken.token, spent: soldToken, received };
  }
  if (gotToken && soldToken) return { kind: 'none', reason: '代币换代币,暂不跟', token: gotToken.token };
  return { kind: 'none', reason: '没有识别到买卖' };
}
