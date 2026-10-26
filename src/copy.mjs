// Copy logic: mirror a target's buy/sell by rewriting its own tx calldata.
//
//   target tx ─▶ detectAction ─▶ candidates (stored route + rewritten tx)
//            ─▶ eth_simulateV1 batch (pick a candidate that really buys/sells
//               with OUR amount) ─▶ detect + fill minOut ─▶ baw preview ─▶ execute
//
// No platform-specific decoders: four.meme, flap, launchpads and DEX routers
// all go through the same path.
import { detectAction } from './action.mjs';
import { NATIVE, WBNB, QUOTES, isQuote, fmtUnits, rawToDecimal, hexNum, topicAddr } from './chain.mjs';
import { previewChanges, previewRisky } from './baw.mjs';
import {
  discoveryCandidates, buildRouteTemplate, routeCandidates, templateFrom,
  setWord, applySlippage, padAddr, W,
} from './route.mjs';

const MAX_UINT = 2n ** 256n - 1n;
const SIM_BALANCE = 10n ** 24n; // native balance override for simulations only
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '?');
const pctBps = (ratio) => BigInt(Math.round(Number(ratio) * 10000));
const toWei = (bnb) => BigInt(Math.round(Number(bnb) * 1e6)) * 10n ** 12n;

export function createCopier({ cfg, chain, wallet, routes, saveRoutes, state, saveState, log, notify, dryRun }) {
  const ME = cfg.wallet;
  const TARGETS = new Map(cfg.targets.map((t) => [t.address, t]));
  const failedUntil = new Map();
  const locks = new Map(); // token -> Promise (serialize trades per token)
  const allowanceOk = new Map(); // `${token}:${spender}` -> expiry

  const inCooldown = (key) => (failedUntil.get(key) || 0) > Date.now();
  const cooldown = (key) => failedUntil.set(key, Date.now() + Number(cfg.copy.failCooldownMs));

  async function withLock(token, fn) {
    const prev = locks.get(token) || Promise.resolve();
    let release;
    const cur = new Promise((r) => { release = r; });
    locks.set(token, prev.then(() => cur));
    await prev;
    try { return await fn(); } finally {
      release();
      if (locks.get(token) === cur) locks.delete(token);
    }
  }

  // ---------- simulation helpers ----------

  const approveData = (spender, amount = MAX_UINT) => '0x095ea7b3' + padAddr(spender) + W(amount);

  /**
   * Simulate candidates and keep the ones that behave like the trade we want.
   * side=buy : spend only `payAsset` (≤ ours·1.01), receive `token`.
   * side=sell: spend only `token` (≤ ours·1.01), receive a quote asset.
   */
  async function simulateCandidates(cands, { side, token, payAsset, ours, value, prelude = [] }) {
    const sims = await chain.simulate(ME, cands.map((c) => ({ to: c.to, value, data: c.data })), { nativeBalance: SIM_BALANCE, prelude });
    if (!sims) return null; // RPC has no eth_simulateV1
    const cap = (ours * 101n) / 100n;
    return cands.map((c, i) => {
      const s = sims[i];
      if (!s.ok) return { ...c, ok: false, why: s.error };
      const g = s.gain;
      const neg = [...g].filter(([, v]) => v < 0n);
      if (side === 'buy') {
        const got = g.get(token) || 0n;
        if (got <= 0n) return { ...c, ok: false, why: '没有买到目标代币' };
        if (neg.some(([a]) => a !== payAsset)) return { ...c, ok: false, why: '会动用其他资产' };
        if (-(g.get(payAsset) || 0n) > cap) return { ...c, ok: false, why: '花费超过跟单金额' };
        return { ...c, ok: true, out: got, outAsset: token, spent: -(g.get(payAsset) || 0n) };
      }
      const sold = -(g.get(token) || 0n);
      if (sold <= 0n) return { ...c, ok: false, why: '没有卖出代币' };
      if (sold > cap) return { ...c, ok: false, why: '卖出数量超过跟单数量' };
      if (neg.some(([a]) => a !== token)) return { ...c, ok: false, why: '会动用其他资产' };
      const pos = [...g].filter(([a, v]) => v > 0n && isQuote(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0];
      if (!pos) return { ...c, ok: false, why: '卖出后没有收到 BNB/稳定币' };
      return { ...c, ok: true, out: pos[1], outAsset: pos[0], spent: sold };
    });
  }

  function pickBest(results) {
    const ok = results.filter((r) => r.ok);
    if (!ok.length) return null;
    // Highest output; stored routes / earlier (more specific) candidates win ties.
    return ok.reduce((best, r) => (r.out > best.out ? r : best), ok[0]);
  }

  /**
   * Find which zeroed words are min-out bounds: filling expected·(1−slip)
   * must still succeed, filling expected·1.5 must revert. Returns
   * { data, minOut, slots } with every confirmed slot filled.
   */
  async function fillMinOut(best, ctx) {
    const minOut = applySlippage(best.out, cfg.slippagePct);
    const high = (best.out * 3n) / 2n;
    let slots = best.minOutWord != null ? [best.minOutWord] : (best.minOutSlots || []);
    slots = slots.slice(0, 8);
    if (!slots.length || minOut <= 0n) return { data: best.data, minOut: 0n, slots: [] };
    const tests = [];
    for (const s of slots) {
      tests.push({ to: best.to, data: setWord(best.data, s, minOut) });
      tests.push({ to: best.to, data: setWord(best.data, s, high) });
    }
    const sims = await chain.simulate(ME, tests.map((t) => ({ ...t, value: ctx.value })), { nativeBalance: SIM_BALANCE, prelude: ctx.prelude });
    if (!sims) return { data: best.data, minOut: 0n, slots: [] };
    const outOf = (s) => (s.ok ? (ctx.side === 'buy' ? s.gain.get(ctx.token) || 0n : s.gain.get(best.outAsset) || 0n) : 0n);
    const confirmed = slots.filter((_, k) => {
      const lo = sims[2 * k];
      const hi = sims[2 * k + 1];
      return lo.ok && outOf(lo) >= minOut && !hi.ok;
    });
    if (!confirmed.length) return { data: best.data, minOut: 0n, slots: [] };
    let data = best.data;
    for (const s of confirmed) data = setWord(data, s, minOut);
    return { data, minOut, slots: confirmed };
  }

  /** Simulation unavailable: try candidates one by one with baw preview (old behavior). */
  async function previewSequential(cands, { side, token, value }) {
    for (const c of cands.slice(0, 6)) {
      let pv;
      try { pv = await wallet.preview(c.to, value, c.data); } catch { continue; }
      if (!pv?.success) continue;
      const ch = previewChanges(pv, ME);
      if (side === 'buy' && (ch.get(token) || 0n) > 0n) return { ...c, ok: true, out: ch.get(token), outAsset: token, pv };
      if (side === 'sell' && (ch.get(token) || 0n) < 0n) {
        const pos = [...ch].find(([a, v]) => v > 0n && isQuote(a));
        if (pos) return { ...c, ok: true, out: pos[1], outAsset: pos[0], pv };
      }
    }
    return null;
  }

  // ---------- allowance ----------

  async function ensureAllowance(token, spender, need) {
    const key = `${token}:${spender}`;
    if ((allowanceOk.get(key) || 0) > Date.now()) return 'ok';
    const cur = await chain.allowance(token, ME, spender);
    if (cur >= need) {
      if (cur >= MAX_UINT / 2n) allowanceOk.set(key, Date.now() + 10 * 60_000);
      return 'ok';
    }
    if (dryRun) return 'dry';
    log('approve_start', { token, spender });
    const pv = await wallet.preview(token, 0n, approveData(spender));
    if (!pv?.success) return `授权预览失败:${pv?.error?.message || '未知'}`;
    const ex = await wallet.execute(pv.data.requestId);
    if (!ex?.success) return `授权执行失败:${ex?.error?.message || '未知'}`;
    if (ex.data?.status === 'PENDING_CONFIRMATION') return 'pending';
    if (ex.data?.txHash) {
      const r = await chain.waitReceipt(ex.data.txHash);
      if (!r) return 'pending';
      if (r.status !== '0x1') return '授权交易失败';
    }
    allowanceOk.set(key, Date.now() + 10 * 60_000);
    log('approve_done', { token, spender, txHash: ex.data?.txHash });
    return 'ok';
  }

  // ---------- route persistence (learnedBuys / fastRoutes / sellRoutes) ----------

  function saveRoute(kind, token, tpl, extra = {}) {
    routes[kind][token] = { ...tpl, ...extra, at: Date.now() };
    saveRoutes();
    log('route_saved', { kind, token, to: tpl.to, minOutWord: tpl.minOutWord ?? null, amountWords: tpl.amountWords });
  }
  // learnedBuys: what the target used (may not have been executed by us yet)
  const saveLearnedRoute = (token, tpl, quote) => saveRoute('learnedBuys', token, tpl, { quote });
  // fastRoutes: a route WE executed successfully; tried first next time
  const saveFastRoute = (token, tpl, quote) => saveRoute('fastRoutes', token, tpl, { quote });

  // ---------- executing a chosen call ----------

  /**
   * Preview → (risk log) → execute. Returns a result object for logging and
   * notifications. In dry-run stops after preview.
   */
  async function previewAndExecute({ side, token, to, value, data, minOut, outAsset, tag }) {
    const t0 = Date.now();
    let pv;
    try { pv = await wallet.preview(to, value, data); } catch (e) { return { ok: false, stage: 'preview', error: e.message }; }
    const tPreview = Date.now() - t0;
    if (!pv?.success) return { ok: false, stage: 'preview', error: pv?.error?.message || 'preview failed', tPreview };
    const ch = previewChanges(pv, ME);
    const previewOut = side === 'buy' ? ch.get(token) || 0n : ch.get(outAsset) || 0n;
    const info = { previewOut, risky: previewRisky(pv), risks: pv.data?.risks?.riskDetails?.length || 0, requestId: pv.data.requestId, tPreview };
    if (minOut > 0n && previewOut > 0n && previewOut < minOut) {
      return { ok: false, stage: 'preview', error: `预估产出 ${previewOut} 低于 minOut ${minOut}`, ...info };
    }
    if (dryRun) return { ok: true, dry: true, ...info };
    let ex;
    try { ex = await wallet.execute(pv.data.requestId); } catch (e) { return { ok: false, stage: 'execute', error: e.message, ...info }; }
    if (!ex?.success) return { ok: false, stage: 'execute', error: ex?.error?.message || 'execute failed', ...info };
    if (ex.data?.status === 'PENDING_CONFIRMATION') return { ok: true, pending: true, orderId: ex.data.orderId, ...info };
    log('executed', { side, token, to, tag, orderId: ex.data?.orderId, txHash: ex.data?.txHash, tTotal: Date.now() - t0 });
    return { ok: true, txHash: ex.data?.txHash, orderId: ex.data?.orderId, ...info };
  }

  // ---------- BUY ----------

  /**
   * Shared buy pipeline for copy buys and Telegram /buy.
   * src: { tx?, payAsset, ours, tag }
   */
  async function buyViaRoutes(token, { tx = null, payAsset, ours, refAmount = 0n, tag, known = null, refTs = null }) {
    const t0 = Date.now();
    const valueCarried = payAsset === NATIVE;
    const value = valueCarried ? ours : 0n;
    const cands = [];
    const fr = routes.fastRoutes[token];
    if (fr?.data && (fr.quote || NATIVE) === payAsset) {
      for (const c of routeCandidates(fr, ours)) cands.push({ ...c, to: fr.to, minOutWord: fr.minOutWord, source: 'fast' });
    }
    const lr = routes.learnedBuys[token];
    if (lr?.data && (lr.quote || NATIVE) === payAsset && (!tx || lr.to !== String(tx.to).toLowerCase())) {
      for (const c of routeCandidates(lr, ours)) cands.push({ ...c, to: lr.to, minOutWord: lr.minOutWord, source: 'learned' });
    }
    if (tx) {
      for (const c of discoveryCandidates(tx, { me: ME, keep: token, refAmount, ourAmount: ours, valueCarried, known, refTs })) {
        cands.push({ ...c, to: String(tx.to).toLowerCase(), minOutWord: null, source: 'target' });
      }
    }
    const seen = new Set();
    const uniq = cands.filter((c) => (seen.has(c.to + c.data) ? false : seen.add(c.to + c.data)));
    if (!uniq.length) return { ok: false, stage: 'route', error: '没有可用路由(该代币没有记录过的路由,也没有目标交易)' };

    // ERC20-paid buys need an allowance for the router; simulate with an approve prelude.
    const prelude = valueCarried ? [] : [...new Set(uniq.map((c) => c.to))].map((to) => ({ to: payAsset, data: approveData(to) }));
    const ctx = { side: 'buy', token, payAsset, ours, value, prelude: prelude.slice(0, 1) };
    let best;
    let results = null;
    if (!valueCarried && prelude.length > 1) {
      // Different spenders: simulate per spender group.
      results = [];
      for (const p of prelude) {
        const group = uniq.filter((c) => c.to === p.to);
        results.push(...((await simulateCandidates(group, { ...ctx, prelude: [p] })) || []));
      }
    } else {
      results = await simulateCandidates(uniq, ctx);
    }
    const tSim = Date.now() - t0;
    if (results) {
      best = pickBest(results);
      if (!best) {
        const why = [...new Set(results.map((r) => r.why).filter(Boolean))].slice(0, 3).join(' / ');
        return { ok: false, stage: 'simulate', error: `${uniq.length} 个候选路由都模拟失败:${why}`, tSim, candidates: uniq.length };
      }
    } else {
      best = await previewSequential(uniq, { side: 'buy', token, value });
      if (!best) return { ok: false, stage: 'preview', error: `${uniq.length} 个候选路由预览都失败(RPC 不支持 eth_simulateV1,已逐个用 baw preview 尝试)` };
    }
    const fill = results
      ? await fillMinOut(best, { ...ctx, prelude: valueCarried ? [] : [{ to: payAsset, data: approveData(best.to) }] })
      : { data: best.data, minOut: 0n, slots: [] };
    const tMin = Date.now() - t0;
    if (fill.minOut === 0n) {
      log('minout_not_found', { token, to: best.to, tag, note: '这条路由没有可识别的 minOut 字段,将以 0 下单' });
      if (cfg.copy.skipIfNoMinOut) return { ok: false, stage: 'minout', error: '找不到 minOut 字段(copy.skipIfNoMinOut=true,跳过)' };
    }

    // Remember the route as soon as it is proven in simulation.
    const tpl = templateFrom(best.to, { ...best, minOutWord: fill.slots[0] ?? best.minOutWord ?? null, minOutSlots: [...(best.minOutSlots || []), ...fill.slots] });
    if (best.source === 'target') saveLearnedRoute(token, tpl, payAsset);

    if (!valueCarried) {
      const bal = await chain.balanceOf(payAsset, ME);
      if (bal == null || bal < ours) {
        return { ok: false, stage: 'balance', error: `${QUOTES.get(payAsset) || payAsset} 余额不足:需要 ${fmtUnits(ours, await chain.decimals(payAsset))}` };
      }
      const a = await ensureAllowance(payAsset, best.to, ours);
      if (a === 'dry') {
        return { ok: true, dry: true, needsApprove: best.to, best, fill, tSim, tMin, note: `需要先授权 ${QUOTES.get(payAsset)} 给 ${best.to},dry-run 未授权,跳过 preview` };
      }
      if (a === 'pending') return { ok: false, stage: 'approve', error: '授权需要 App 确认,确认后会自动继续跟踪;本次跟买跳过' };
      if (a !== 'ok') return { ok: false, stage: 'approve', error: a };
    }
    const res = await previewAndExecute({ side: 'buy', token, to: best.to, value, data: fill.data, minOut: fill.minOut, outAsset: token, tag });
    const out = { ...res, best, fill, tSim, tMin, tTotal: Date.now() - t0, value, payAsset, ours, candidates: uniq.length };
    if (res.ok && !res.dry) {
      saveFastRoute(token, tpl, payAsset);
      // Pre-approve the token to the same router so a copy sell does not wait on an approve.
      if (cfg.copy.preApproveSell) void ensureAllowance(token, best.to, 1n).catch(() => {});
    }
    return out;
  }

  async function copyBuy(tx, act, tgt) {
    const token = act.token;
    const payAsset = act.spent.token;
    let ours = (act.spent.raw * pctBps(tgt.sizeRatio)) / 10000n;
    const nativeLike = payAsset === NATIVE || payAsset === WBNB;
    if (nativeLike && cfg.copy.maxBuyBnb != null && ours > toWei(cfg.copy.maxBuyBnb)) ours = toWei(cfg.copy.maxBuyBnb);
    if (nativeLike && ours < toWei(cfg.copy.minBuyBnb)) {
      log('buy_skipped', { tx: tx.hash, token, reason: `跟单金额低于 minBuyBnb ${cfg.copy.minBuyBnb}`, ours });
      return;
    }
    if (ours <= 0n) { log('buy_skipped', { tx: tx.hash, token, reason: '跟单金额为 0' }); return; }
    const pending = wallet.pendingOrderFor(token);
    if (pending) { log('buy_skipped', { tx: tx.hash, token, reason: `有待 App 确认订单 ${pending}` }); return; }
    if (inCooldown(`buy:${token}`)) { log('buy_skipped', { tx: tx.hash, token, reason: '失败冷却中' }); return; }

    const payDec = await chain.decimals(payAsset);
    const paySym = QUOTES.get(payAsset) || await chain.symbol(payAsset);
    const sym = await chain.symbol(token);
    const known = knownAddresses(tx, act.receipt);
    const refTs = await txTimestamp(tx, act.receipt);
    const res = await buyViaRoutes(token, { tx, payAsset, ours, refAmount: act.spent.raw, tag: tgt.label, known, refTs });
    const dec = await chain.decimals(token);
    const base = {
      tx: tx.hash, target: tgt.label, token, sym, router: res.best?.to, source: res.best?.source,
      pay: `${fmtUnits(ours, payDec)} ${paySym}`, candidates: res.candidates,
      expectedOut: res.best?.out ? fmtUnits(res.best.out, dec) : null,
      minOut: res.fill?.minOut ? fmtUnits(res.fill.minOut, dec) : 0,
      minOutSlots: res.fill?.slots, previewOut: res.previewOut ? fmtUnits(res.previewOut, dec) : null,
      tSim: res.tSim, tMin: res.tMin, tPreview: res.tPreview, tTotal: res.tTotal,
    };
    if (!res.ok) {
      // Route could not be mirrored. For a BNB/WBNB buy, try the aggregator
      // (MEV-protected) before giving up; it covers tokens whose custom router
      // we cannot rewrite but that have public liquidity.
      if (cfg.copy.buyMarketFallback && nativeLike && ['route', 'simulate', 'preview', 'minout'].includes(res.stage)) {
        const m = await marketBuy(token, ours, payAsset === WBNB ? WBNB : NATIVE);
        log(m.dry ? 'would_market_buy' : (m.ok ? 'market_buy_sent' : 'market_buy_failed'), { ...base, routeStage: res.stage, orderId: m.orderId, error: m.error, quote: m.quote ? { toCoinAmount: m.quote.toCoinAmount } : undefined });
        if (m.ok && !m.dry) { await notify(`↪️ 路由无法镜像,改走聚合器(MEV 保护)买入 ${sym}\n花费 ${base.pay} · 订单 ${m.orderId}`); return; }
        if (m.ok) return;
        res.stage = `route→market`; res.error = m.error || res.error;
      }
      cooldown(`buy:${token}`);
      log('buy_failed', { ...base, stage: res.stage, error: res.error });
      await notify(`❌ 跟买失败 ${sym}\n目标 ${tgt.label} · ${short(tx.hash)}\n${res.stage}: ${res.error}`);
      return;
    }
    if (res.dry) {
      log('would_buy', { ...base, note: res.note, requestId: res.requestId, risks: res.risks });
      return;
    }
    if (res.pending) {
      await notify(`⏳ 跟买待 App 确认 ${sym}\n花费 ${base.pay}\n订单 ${res.orderId}`);
      return;
    }
    log('buy_done', { ...base, txHash: res.txHash });
    await notify(`✅ 跟买 ${sym}\n目标 ${tgt.label}\n花费 ${base.pay}\n预计到账 ${base.expectedOut}(最少 ${base.minOut})\ntx ${res.txHash || res.orderId}`);
  }

  // ---------- SELL ----------

  async function sellViaRoutes(token, { tx = null, ours, refAmount = 0n, tag, known = null, refTs = null }) {
    const t0 = Date.now();
    const cands = [];
    const sr = routes.sellRoutes[token];
    if (sr?.data) for (const c of routeCandidates(sr, ours)) cands.push({ ...c, to: sr.to, minOutWord: sr.minOutWord, source: 'sellRoute' });
    if (tx) {
      for (const c of discoveryCandidates(tx, { me: ME, keep: token, refAmount, ourAmount: ours, valueCarried: false, known, refTs })) {
        cands.push({ ...c, to: String(tx.to).toLowerCase(), minOutWord: null, source: 'target' });
      }
    }
    const seen = new Set();
    const uniq = cands.filter((c) => (seen.has(c.to + c.data) ? false : seen.add(c.to + c.data)));
    if (!uniq.length) return { ok: false, stage: 'route', error: '没有可用卖出路由' };

    const spenders = [...new Set(uniq.map((c) => c.to))];
    const results = [];
    let simOk = true;
    for (const sp of spenders) {
      const group = uniq.filter((c) => c.to === sp);
      // The token itself (curve tokens with a sell() function) needs no approve.
      const prelude = sp === token ? [] : [{ to: token, data: approveData(sp) }];
      const r = await simulateCandidates(group, { side: 'sell', token, ours, value: 0n, prelude });
      if (!r) { simOk = false; break; }
      results.push(...r);
    }
    const tSim = Date.now() - t0;
    let best;
    if (simOk) {
      best = pickBest(results);
      if (!best) {
        const why = [...new Set(results.map((r) => r.why).filter(Boolean))].slice(0, 3).join(' / ');
        return { ok: false, stage: 'simulate', error: `${uniq.length} 个卖出候选都模拟失败:${why}`, tSim, candidates: uniq.length };
      }
    } else {
      best = await previewSequential(uniq, { side: 'sell', token, value: 0n });
      if (!best) return { ok: false, stage: 'preview', error: '卖出候选预览都失败' };
    }
    const prelude = best.to === token ? [] : [{ to: token, data: approveData(best.to) }];
    const fill = simOk ? await fillMinOut(best, { side: 'sell', token, value: 0n, prelude }) : { data: best.data, minOut: 0n, slots: [] };
    const tMin = Date.now() - t0;
    if (fill.minOut === 0n) log('minout_not_found', { token, to: best.to, side: 'sell', tag });
    const tpl = templateFrom(best.to, { ...best, minOutWord: fill.slots[0] ?? best.minOutWord ?? null, minOutSlots: [...(best.minOutSlots || []), ...fill.slots] });
    if (best.source === 'target') saveRoute('sellRoutes', token, tpl, { quote: best.outAsset });

    if (best.to !== token) {
      const a = await ensureAllowance(token, best.to, ours);
      if (a === 'dry') return { ok: true, dry: true, needsApprove: best.to, best, fill, tSim, tMin, note: `需要先授权代币给 ${best.to},dry-run 未授权,跳过 preview` };
      if (a === 'pending') return { ok: false, stage: 'approve', error: '授权需要 App 确认,确认后请重新 /sell' };
      if (a !== 'ok') return { ok: false, stage: 'approve', error: a };
    }
    const res = await previewAndExecute({ side: 'sell', token, to: best.to, value: 0n, data: fill.data, minOut: fill.minOut, outAsset: best.outAsset, tag });
    return { ...res, best, fill, tSim, tMin, tTotal: Date.now() - t0, candidates: uniq.length };
  }

  // Aggregator fallback (Binance market-order, MEV-protected) when no route works.
  async function marketSell(token, ours, toToken) {
    const dec = await chain.decimals(token);
    const qty = rawToDecimal(ours, dec);
    const args = ['market-order', 'swap', '--binanceChainId', cfg.chainId, '--fromToken', token, '--toToken', toToken,
      '--fromTokenQty', qty, '--slippage', String(cfg.market.slippagePct), '--mev', String(cfg.market.mev), '--gasLevel', cfg.market.gasLevel];
    if (dryRun) {
      let q = null;
      try { q = await wallet.baw(['market-order', 'quote', '--binanceChainId', cfg.chainId, '--fromToken', token, '--toToken', toToken, '--fromTokenQty', qty, '--slippage', String(cfg.market.slippagePct)]); } catch { /* ignore */ }
      return { ok: !!q?.success, dry: true, quote: q?.data, error: q?.success ? null : q?.error?.message };
    }
    const since = Date.now();
    const res = await wallet.baw(args);
    if (!res?.success) return { ok: false, error: res?.error?.message || 'market-order failed' };
    void (async () => {
      const o = await wallet.waitDexOrder(token, toToken, since, res.data?.orderId);
      const sym = await chain.symbol(token);
      if (o?.status === 'FINISHED') await notify(`✅ 聚合器卖出成交 ${sym}\n收到 ${o.toTokenActualQty} ${o.toTokenName || ''}\ntx ${o.txHash || ''}`);
      else if (o?.status === 'FAILED') await notify(`❌ 聚合器卖出失败 ${sym}\n订单 ${o.orderId}`);
      else await notify(`⏳ 聚合器卖出尚未确认 ${sym}\n订单 ${res.data?.orderId}`);
    })().catch(() => {});
    return { ok: true, orderId: res.data?.orderId };
  }

  // Aggregator fallback for a native/WBNB buy when no route can be mirrored.
  async function marketBuy(token, bnbWei, fromToken = NATIVE) {
    const qty = rawToDecimal(bnbWei, 18);
    if (dryRun) {
      let q = null;
      try { q = await wallet.baw(['market-order', 'quote', '--binanceChainId', cfg.chainId, '--fromToken', fromToken, '--toToken', token, '--fromTokenQty', qty, '--slippage', String(cfg.market.slippagePct)]); } catch { /* ignore */ }
      return { ok: !!q?.success, dry: true, quote: q?.data, error: q?.success ? null : q?.error?.message };
    }
    const since = Date.now();
    const res = await wallet.baw(['market-order', 'swap', '--binanceChainId', cfg.chainId, '--fromToken', fromToken, '--toToken', token,
      '--fromTokenQty', qty, '--slippage', String(cfg.market.slippagePct), '--mev', String(cfg.market.mev), '--gasLevel', cfg.market.gasLevel]);
    if (!res?.success) return { ok: false, error: res?.error?.message || 'market-order failed' };
    const o = await wallet.waitDexOrder(fromToken, token, since, res.data?.orderId);
    return { ok: o ? o.status === 'FINISHED' : true, order: o, orderId: res.data?.orderId };
  }

  async function copySell(tx, act, tgt) {
    const token = act.token;
    const sym = await chain.symbol(token);
    const dec = await chain.decimals(token);
    const pending = wallet.pendingOrderFor(token);
    if (pending) { log('sell_skipped', { tx: tx.hash, token, reason: `有待 App 确认订单 ${pending}` }); return; }
    const ourBal = (await chain.balanceOf(token, ME)) ?? 0n;
    if (ourBal === 0n) { log('sell_skipped', { tx: tx.hash, token, sym, reason: '我们没有持仓' }); return; }

    // Target's position fraction = sold / (balance after this block + sold).
    const blk = act.receipt?.blockNumber || 'latest';
    const targetAfter = (await chain.balanceOf(token, tx.from, blk).catch(() => null)) ?? (await chain.balanceOf(token, tx.from)) ?? 0n;
    const sold = act.spent.raw;
    let bps = targetAfter + sold > 0n ? Number((sold * 10000n) / (targetAfter + sold)) : 10000;
    bps = Math.min(10000, Math.max(bps, Number(cfg.copy.sellMinRatioBps)));
    let ours = (ourBal * BigInt(bps)) / 10000n;
    if (bps >= Number(cfg.copy.sellFullExitBps)) ours = ourBal;
    if (ours === 0n) { log('sell_skipped', { tx: tx.hash, token, reason: '计算出的卖出数量为 0', bps }); return; }

    const known = knownAddresses(tx, act.receipt);
    const refTs = await txTimestamp(tx, act.receipt);
    const res = await sellViaRoutes(token, { tx, ours, refAmount: sold, tag: tgt.label, known, refTs });
    const outDec = res.best?.outAsset ? await chain.decimals(res.best.outAsset) : 18;
    const outSym = res.best?.outAsset ? (QUOTES.get(res.best.outAsset) || await chain.symbol(res.best.outAsset)) : '';
    const base = {
      tx: tx.hash, target: tgt.label, token, sym, targetPct: bps / 100, sell: fmtUnits(ours, dec), router: res.best?.to,
      expectedOut: res.best?.out ? `${fmtUnits(res.best.out, outDec)} ${outSym}` : null,
      minOut: res.fill?.minOut ? `${fmtUnits(res.fill.minOut, outDec)} ${outSym}` : 0,
      tSim: res.tSim, tMin: res.tMin, tPreview: res.tPreview, tTotal: res.tTotal,
    };
    if (res.ok && res.dry) { log('would_sell', { ...base, note: res.note, requestId: res.requestId }); return; }
    if (res.ok && res.pending) { await notify(`⏳ 跟卖待 App 确认 ${sym} ${bps / 100}%\n订单 ${res.orderId}`); return; }
    if (res.ok) {
      log('sell_done', { ...base, txHash: res.txHash });
      await notify(`✅ 跟卖 ${sym} ${bps / 100}%\n卖出 ${base.sell}\n预计收到 ${base.expectedOut}(最少 ${base.minOut})\ntx ${res.txHash || res.orderId}`);
      return;
    }
    log('sell_route_failed', { ...base, stage: res.stage, error: res.error });
    // Fallback: aggregator, but only when the target really sold for a quote
    // (do not dump our tokens because the target staked or moved them).
    if (cfg.copy.sellMarketFallback && !act.nativeUnknown && res.stage !== 'approve') {
      const toToken = act.received.token === WBNB ? NATIVE : act.received.token;
      const m = await marketSell(token, ours, toToken);
      log(m.dry ? 'would_market_sell' : (m.ok ? 'market_sell_sent' : 'market_sell_failed'), { ...base, toToken, orderId: m.orderId, error: m.error, quote: m.quote ? { toTokenQty: m.quote.toTokenQty ?? m.quote.toTokenAmount } : undefined });
      if (m.ok && !m.dry) { await notify(`↪️ 路由卖出失败,已改走聚合器(MEV 保护)\n${sym} ${bps / 100}% · 订单 ${m.orderId}`); return; }
      if (m.ok) return;
    }
    await notify(`❌ 跟卖失败 ${sym} ${bps / 100}%\n${res.stage}: ${res.error}`);
  }

  // Target block timestamp (seconds), for refreshing packed deadlines. Some
  // RPCs omit blockTimestamp on getTransactionByHash, so read the block header
  // (cached) as a fallback. On total failure, `now` (word-aligned deadlines are
  // still refreshed by magnitude; only mid-word packed ones need the exact ts).
  const tsCache = new Map();
  async function txTimestamp(tx, receipt) {
    const t = tx?.blockTimestamp ?? receipt?.blockTimestamp;
    if (t != null) { try { return Number(BigInt(t)); } catch { /* ignore */ } }
    const bn = tx?.blockNumber ?? receipt?.blockNumber;
    if (bn != null) {
      const key = String(bn);
      if (tsCache.has(key)) return tsCache.get(key);
      try {
        const blk = await chain.rpc('eth_getBlockByNumber', [hexNum(BigInt(bn)), false]);
        if (blk?.timestamp) { const v = Number(BigInt(blk.timestamp)); tsCache.set(key, v); return v; }
      } catch { /* ignore */ }
    }
    return Math.floor(Date.now() / 1000);
  }

  // Addresses seen in the tx (to, log emitters, log topics) — words matching
  // these are addresses even when numerically small.
  function knownAddresses(tx, receipt) {
    const s = new Set([String(tx.to || '').toLowerCase(), String(tx.from || '').toLowerCase()]);
    for (const l of receipt?.logs || []) {
      s.add(String(l.address).toLowerCase());
      for (const t of (l.topics || []).slice(1)) if (/^0x0{24}/.test(t)) s.add(topicAddr(t));
    }
    for (const q of QUOTES.keys()) s.add(q);
    return s;
  }

  // BNB the target received in this tx (internal transfers do not emit logs):
  // balance(after) − balance(before) + gas + value. null when state is pruned.
  async function nativeReceived(tx, receipt) {
    try {
      const n = BigInt(receipt.blockNumber);
      const [after, before] = await Promise.all([
        chain.rpc('eth_getBalance', [tx.from, hexNum(n)]),
        chain.rpc('eth_getBalance', [tx.from, hexNum(n - 1n)]),
      ]);
      const gas = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice || tx.gasPrice || 0);
      return BigInt(after) - BigInt(before) + gas + BigInt(tx.value || 0);
    } catch { return null; }
  }

  // ---------- entry ----------

  async function handleTx(tx, receipt, { replay = false } = {}) {
    const tgt = TARGETS.get(String(tx.from).toLowerCase()) || (replay ? { address: tx.from, label: 'replay', sizeRatio: cfg.sizeRatio } : null);
    if (!tgt) return;
    let act = detectAction(tx, receipt, null);
    if (act.kind === 'none' && /没有收到计价币/.test(act.reason || '')) {
      const nin = await nativeReceived(tx, receipt);
      act = detectAction(tx, receipt, nin);
      if (nin == null) act.nativeUnknown = true;
    } else if (act.kind === 'sell' && act.received.raw === 0n) {
      act.nativeUnknown = true;
    }
    act.receipt = receipt;
    log('target_tx', {
      tx: tx.hash, target: tgt.label, kind: act.kind, reason: act.reason, token: act.token,
      to: tx.to, selector: String(tx.input || '').slice(0, 10),
      spent: act.spent ? `${fmtUnits(act.spent.raw, await chain.decimals(act.spent.token))} ${QUOTES.get(act.spent.token) || await chain.symbol(act.spent.token)}` : undefined,
      received: act.received ? `${fmtUnits(act.received.raw, await chain.decimals(act.received.token))} ${QUOTES.get(act.received.token) || await chain.symbol(act.received.token)}` : undefined,
    });
    if (act.kind === 'buy' && cfg.copy.buys) await withLock(act.token, () => copyBuy(tx, act, tgt));
    else if (act.kind === 'sell' && cfg.copy.sells) await withLock(act.token, () => copySell(tx, act, tgt));
  }

  // ---------- manual (Telegram) ----------

  async function manualBuy(token, bnb) {
    const ours = toWei(bnb);
    return withLock(token, async () => {
      const res = await buyViaRoutes(token, { payAsset: NATIVE, ours, tag: 'manual' });
      if (res.ok) return res;
      if (res.stage !== 'route' && res.stage !== 'simulate') return res;
      // No recorded route: use the aggregator.
      if (dryRun) return { ok: false, error: 'dry-run 下不执行聚合器买入' };
      const since = Date.now();
      const m = await wallet.baw(['market-order', 'swap', '--binanceChainId', cfg.chainId, '--fromToken', NATIVE, '--toToken', token,
        '--fromTokenQty', String(bnb), '--slippage', String(cfg.market.slippagePct), '--mev', String(cfg.market.mev), '--gasLevel', cfg.market.gasLevel]);
      if (!m?.success) return { ok: false, stage: 'market', error: m?.error?.message || 'market-order failed' };
      const o = await wallet.waitDexOrder(NATIVE, token, since, m.data?.orderId);
      return { ok: o?.status === 'FINISHED', market: true, order: o, orderId: m.data?.orderId, error: o?.status === 'FAILED' ? '聚合器订单失败' : null };
    });
  }

  async function manualSell(token, pct) {
    return withLock(token, async () => {
      const bal = (await chain.balanceOf(token, ME)) ?? 0n;
      if (bal === 0n) return { ok: false, error: '没有持仓' };
      const ours = pct >= 100 ? bal : (bal * BigInt(Math.round(pct * 100))) / 10000n;
      const res = await sellViaRoutes(token, { ours, tag: 'manual' });
      if (res.ok || res.stage === 'approve') return res;
      const sr = routes.sellRoutes[token];
      const m = await marketSell(token, ours, sr?.quote && sr.quote !== WBNB ? sr.quote : NATIVE);
      return { ...m, market: true };
    });
  }

  return { handleTx, manualBuy, manualSell, TARGETS };
}
