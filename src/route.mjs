// Calldata rewriting: turn a target's tx into OUR calldata (our address, our
// amount, fresh deadline) and fill the minOut word once we know the expected
// output. Pure functions — no I/O — so they are unit-testable.
//
// Origin: buildRouteTemplate / discoveryCandidates / routeCandidates from the
// old copytrader.mjs, generalized to sells and ERC20-quoted buys. Zeroed
// minOut slots are tracked so they can be filled instead of left at 0.

export const W = (x) => BigInt(x).toString(16).padStart(64, '0');
export const padAddr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');

const ZERO_WORD = '0'.repeat(64);
const isTsSec = (v) => v >= 1_600_000_000n && v <= 2_000_000_000n;
const isTsMs = (v) => v >= 1_600_000_000_000n && v <= 2_000_000_000_000n;
const isTs = (v) => isTsSec(v) || isTsMs(v);
// Address-shaped: upper 12 bytes zero and big enough to not be a plain number.
const isAddrWord = (lw) => lw.startsWith('0'.repeat(24)) && BigInt('0x' + lw) > 10n ** 30n;
const SMALL = 10n ** 9n;       // flags, ids, offsets, lengths, fee tiers: keep
const OPAQUE = 2n ** 128n;     // packed paths, command bytes, MAX/CONTRACT_BALANCE sentinels: keep

export function splitWords(input) {
  const s = String(input || '0x');
  const sel = s.slice(0, 10).toLowerCase();
  const body = s.slice(10);
  const words = [];
  for (let i = 0; i + 64 <= body.length; i += 64) words.push(body.slice(i, i + 64).toLowerCase());
  const tail = body.slice(words.length * 64);
  return { sel, words, tail };
}

const freshDeadline = (v, nowSec) => (isTsSec(v) ? W(nowSec + 600) : W((nowSec + 600) * 1000));

/**
 * Classify every word of a target call and produce our base words.
 * Returns { base, numeric } where numeric = indexes of amount-like words
 * (zeroed in base; each is either an amount or a min/max bound).
 *
 * A word equal to the target's amount is always numeric, even if it looks
 * like an address (huge-supply tokens: 1e33 raw has 12 zero high bytes).
 * Otherwise address-shaped words count as addresses only when known from the
 * tx context or > 2^152 (random addresses are almost never smaller).
 */
const ADDR_MIN = 2n ** 152n;
function rewriteWords(words, { target, me, keep, ref = 0n, known = null }, nowSec) {
  const keepHex = String(keep || '').toLowerCase().slice(2);
  const numeric = [];
  const base = words.map((lw, i) => {
    if (keepHex && lw.slice(24) === keepHex) return lw;
    const v = BigInt('0x' + lw);
    if (ref > 0n && v === ref) { numeric.push(i); return ZERO_WORD; }
    if (isTs(v)) return freshDeadline(v, nowSec);
    if (isAddrWord(lw)) {
      const a = '0x' + lw.slice(24);
      if (a === target) return padAddr(me);
      if (v >= ADDR_MIN || known?.has(a) || !known) return lw;
    }
    if (v < SMALL || v >= OPAQUE) return lw;
    numeric.push(i);
    return ZERO_WORD;
  });
  return { base, numeric };
}

function replacer(target, me) {
  const t = String(target || '').toLowerCase().slice(2);
  const m = String(me).toLowerCase().slice(2);
  // Also catches the target address inside non-word-aligned bytes (packed data).
  return (s) => (t ? s.replace(new RegExp(t, 'gi'), m) : s);
}

/**
 * Refresh deadlines packed at non-word-aligned byte offsets. Custom routers
 * encode hop data with abi.encodePacked, so a deadline can sit mid-word and
 * the word-level rewriter misses it ("Route: expired"). Any byte-aligned
 * 4-byte big-endian value inside [refTs-120, refTs+7200] is set to now+600.
 */
export function refreshPackedTimestamps(data, refTs, nowSec = Math.floor(Date.now() / 1000)) {
  if (!refTs) return data;
  const lo = refTs - 120;
  const hi = refTs + 7200;
  const fresh = (nowSec + 600).toString(16).padStart(8, '0');
  const sel = data.slice(0, 10);
  let body = data.slice(10);
  for (let p = 0; p + 8 <= body.length; p += 2) {
    const v = parseInt(body.slice(p, p + 8), 16);
    if (v >= lo && v <= hi) { body = body.slice(0, p) + fresh + body.slice(p + 8); p += 6; }
  }
  return sel + body;
}

/**
 * Candidate calls built from a target tx. Three families, because routers
 * disagree about which numbers may be touched:
 *   Z  amount-like words zeroed, ours in the amount word (simple routers,
 *      launchpads; the old script's only strategy)
 *   S  amount-like words scaled by ours/ref (aggregators whose per-hop amounts
 *      must stay internally consistent)
 *   K  amount-like words kept as the target's, only the amount word changed
 * S and K are also emitted with each other numeric word zeroed in turn (that
 * word is the target's minOut, too high for our smaller size). Every
 * candidate is simulated, so wrong shapes are discarded, not executed.
 *
 * @param {object} tx  target tx ({ input, from })
 * @param {object} o
 * @param {string} o.me          our wallet
 * @param {string} o.keep        traded token (its address word is kept)
 * @param {bigint} o.refAmount   target's amount on the side we scale
 *                               (native buy: tx.value; ERC20 buy: quote spent; sell: tokens sold)
 * @param {bigint} o.ourAmount   our scaled amount
 * @param {boolean} o.valueCarried  amount rides in msg.value (native buy)
 * @param {Set<string>} [o.known]  addresses seen in the tx (to, logs, topics)
 * @param {number} [o.refTs]     target block timestamp (for packed deadline refresh)
 * @param {number} [o.max]       candidate cap
 * @returns {{data:string, amountWords:number[], minOutSlots:number[], family:string}[]}
 */
export function discoveryCandidates(tx, { me, keep, refAmount, ourAmount, valueCarried, known = null, refTs = null, max = 60 }, nowSec = Math.floor(Date.now() / 1000)) {
  const { sel, words, tail } = splitWords(tx.input);
  if (sel.length < 10) return [];
  if (!words.length) return [{ data: sel, amountWords: [], minOutSlots: [], family: 'Z' }];
  const target = String(tx.from || '').toLowerCase();
  const ref = BigInt(refAmount || 0n);
  const ours = BigInt(ourAmount || 0n);
  const { base, numeric } = rewriteWords(words, { target, me, keep, ref, known }, nowSec);
  const rep = replacer(target, me);
  const finish = (ws) => refreshPackedTimestamps(rep(sel + ws.join('') + tail), refTs, nowSec);
  const exact = numeric.filter((i) => ref > 0n && BigInt('0x' + words[i]) === ref);
  const others = numeric.filter((i) => !exact.includes(i));
  const orig = (i) => BigInt('0x' + words[i]);
  const scale = (v) => (ref > 0n ? (v * ours) / ref : v);

  const out = [];
  const push = (family, ws, amountWords, minOutSlots) => out.push({ data: finish(ws), amountWords, minOutSlots, family });
  const make = (fill) => { const ws = base.slice(); for (const i of numeric) ws[i] = W(fill(i)); return ws; };
  const zeroAt = (ws, i) => { const c = ws.slice(); c[i] = ZERO_WORD; return c; };

  const Z = make((i) => (exact.includes(i) ? ours : 0n));
  const S = make((i) => (exact.includes(i) ? ours : scale(orig(i))));
  const K = make((i) => (exact.includes(i) ? ours : orig(i)));

  // Most-likely shapes first; the cap drops the long tail.
  if (exact.length) push('Z', Z, exact, others);
  if (exact.length > 1) for (const i of exact) push('Z', make((j) => (j === i ? ours : 0n)), [i], numeric.filter((j) => j !== i));
  if (valueCarried) push('Z', make(() => 0n), [], numeric);
  if (ref > 0n && others.length) {
    push('S', S, exact, []);
    for (const i of others) push('S', zeroAt(S, i), exact, [i]);
    push('K', K, exact, []);
    for (const i of others) push('K', zeroAt(K, i), exact, [i]);
  }
  // Single-word amount guesses (unknown exact amount word).
  for (const i of others) {
    push('Z', make((j) => (j === i ? ours : 0n)), [i], numeric.filter((j) => j !== i));
    if (ref > 0n) { const sc = scale(orig(i)); if (sc > 0n) { const ws = base.slice(); ws[i] = W(sc); push('Z', ws, [i], numeric.filter((j) => j !== i)); } }
  }
  // Always keep the base shape (addresses + deadline rewritten, no numeric
  // words touched). It is the only candidate for amount-less payable calls and
  // a safe last resort for routes whose amount is carried entirely in value.
  if (!out.length || !valueCarried) push('Z', base.slice(), [], numeric);
  const seen = new Set();
  return out.filter((c) => (seen.has(c.data) ? false : seen.add(c.data))).slice(0, max);
}

/**
 * Reusable template from a target tx: target -> us, fresh deadline, numeric
 * words zeroed. `amountWords` = words that held the target's amount.
 */
export function buildRouteTemplate(tx, { me, keep, refAmount, known = null }, nowSec = Math.floor(Date.now() / 1000)) {
  const { sel, words, tail } = splitWords(tx.input);
  if (sel.length < 10) return null;
  const to = String(tx.to || '').toLowerCase();
  if (!words.length) return { to, data: sel, amountWords: [], minOutWord: null };
  const target = String(tx.from || '').toLowerCase();
  const ref = BigInt(refAmount || 0n);
  const { base, numeric } = rewriteWords(words, { target, me, keep, ref, known }, nowSec);
  const amountWords = numeric.filter((i) => ref > 0n && BigInt('0x' + words[i]) === ref);
  return { to, data: replacer(target, me)(sel + base.join('') + tail), amountWords, minOutWord: null };
}

/**
 * Candidates for a stored route: fresh deadline, our amount in the amount
 * word(s). When minOutWord is unknown every other zero word is a minOut guess.
 */
export function routeCandidates(route, amount, nowSec = Math.floor(Date.now() / 1000)) {
  if (!route?.data || route.data.length < 10) return [];
  const { sel, words, tail } = splitWords(route.data);
  const amountWords = (route.amountWords || (route.amountWord != null ? [route.amountWord] : [])).filter((i) => i < words.length);
  const zeros = words.map((w, i) => (w === ZERO_WORD ? i : -1)).filter((i) => i >= 0);
  const build = (idxs) => sel + words.map((w, j) => {
    if (idxs.includes(j)) return W(amount);
    const x = BigInt('0x' + w);
    if (isTs(x)) return freshDeadline(x, nowSec);
    return w;
  }).join('') + tail;
  const slotsFor = (aw) => (route.minOutWord != null ? [route.minOutWord] : zeros.filter((i) => !aw.includes(i)));
  const out = [];
  if (amountWords.length) out.push({ data: build(amountWords), amountWords, minOutSlots: slotsFor(amountWords) });
  out.push({ data: build([]), amountWords: [], minOutSlots: slotsFor([]) });
  if (!amountWords.length) {
    for (const i of zeros) if (i !== route.minOutWord) out.push({ data: build([i]), amountWords: [i], minOutSlots: slotsFor([i]) });
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.data) ? false : seen.add(c.data)));
}

/** Template to store after a candidate worked: amounts and minOut back to 0. */
export function templateFrom(to, cand) {
  const { sel, words, tail } = splitWords(cand.data);
  const zeroAt = new Set([...(cand.amountWords || []), ...(cand.minOutSlots || [])]);
  return {
    to: String(to).toLowerCase(),
    data: sel + words.map((w, i) => (zeroAt.has(i) ? ZERO_WORD : w)).join('') + tail,
    amountWords: cand.amountWords || [],
    minOutWord: cand.minOutWord ?? null,
  };
}

/** Put `value` into word `slot` of calldata. */
export function setWord(data, slot, value) {
  const { sel, words, tail } = splitWords(data);
  if (slot == null || slot < 0 || slot >= words.length) return data;
  const ws = words.slice();
  ws[slot] = W(value);
  return sel + ws.join('') + tail;
}

/** minOut = expected × (1 − slippage%). */
export function applySlippage(expected, slippagePct) {
  const bps = BigInt(Math.round((100 - Number(slippagePct)) * 100));
  return (BigInt(expected) * bps) / 10000n;
}
