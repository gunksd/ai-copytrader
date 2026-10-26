// Binance Agentic Wallet CLI wrapper. All signing/broadcast goes through
// `baw`; this process never touches a private key.
//
// Ported from the old copytrader.mjs: baw() (incl. the Windows exit-code
// workaround), waitDexOrder(), trackPendingConfirmation().
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function locateCli(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.BAW_CLI) cands.push(process.env.BAW_CLI);
  cands.push(
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js'),
    '/usr/local/lib/node_modules/@binance/agentic-wallet/dist/index.js',
    '/opt/homebrew/lib/node_modules/@binance/agentic-wallet/dist/index.js',
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js'),
  );
  try {
    const root = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', timeout: 10_000, shell: process.platform === 'win32' }).trim();
    cands.push(path.join(root, '@binance', 'agentic-wallet', 'dist', 'index.js'));
  } catch { /* npm missing — rely on the static list */ }
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

const argAfter = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBaw({ cliPath, chainId, me, state, saveState, log, notify = async () => {} }) {
  const CLI = locateCli(cliPath);
  const pendingPreview = new Map(); // requestId -> { to, value, inputData, at }
  const trackedPending = new Set();
  const pendingHandlers = []; // callbacks(orderId, meta, hit) on App-confirmed fills

  async function baw(args) {
    if (!CLI) throw new Error('找不到 @binance/agentic-wallet CLI,请先 npm i -g @binance/agentic-wallet');
    const opts = { env: process.env, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 };
    let stdout;
    try {
      ({ stdout } = await execFileP(process.execPath, [CLI, ...args, '--json'], opts));
    } catch (e) {
      // On Windows the CLI can print its JSON and then abort on exit (libuv
      // assertion). Prefer the printed result over the exit code, otherwise a
      // successful order would be misreported as failed.
      if (typeof e?.stdout === 'string' && e.stdout.includes('{')) stdout = e.stdout;
      else throw e;
    }
    const start = stdout.indexOf('{');
    if (start < 0) throw new Error(`baw 没有返回 JSON:${stdout.slice(0, 200)}`);
    const res = JSON.parse(stdout.slice(start));
    if (args[0] === 'contract-call') {
      if (args[1] === 'preview' && res?.success && res.data?.requestId) {
        pendingPreview.set(String(res.data.requestId), {
          to: String(argAfter(args, '--to') || '').toLowerCase(),
          value: String(argAfter(args, '--value') || '0'),
          inputData: String(argAfter(args, '--inputData') || '0x'),
          at: Date.now(),
        });
        if (pendingPreview.size > 200) {
          for (const [k, v] of pendingPreview) if (Date.now() - v.at > 30 * 60_000) pendingPreview.delete(k);
        }
      } else if (args[1] === 'execute' && res?.success && res.data?.status === 'PENDING_CONFIRMATION') {
        const meta = pendingPreview.get(String(argAfter(args, '--requestId') || '')) || null;
        void trackPendingConfirmation(res.data.orderId, meta);
      }
    }
    return res;
  }

  const preview = (to, value, inputData) => baw([
    'contract-call', 'preview', '--binanceChainId', chainId, '--from', me,
    '--to', to, '--value', BigInt(value).toString(), '--inputData', inputData,
  ]);
  const execute = (requestId) => baw(['contract-call', 'execute', '--requestId', String(requestId)]);

  async function waitDexOrder(fromToken, toToken, since, orderId = null, tries = 20) {
    const done = (o) => !!o && (o.status === 'FINISHED' || o.status === 'FAILED');
    for (let i = 0; i < tries; i++) {
      try {
        const j = await baw(['market-order', 'list', '--binanceChainId', chainId, '--pageSize', '20']);
        const list = j?.data?.list || [];
        // The orderId returned by `swap` is NOT always the id in the order
        // list, so fall back to the newest matching order booked after `since`.
        const exact = orderId ? list.find((o) => String(o.orderId ?? o.id ?? '') === String(orderId)) : null;
        const fallback = list
          .filter((o) =>
            o.fromToken?.toLowerCase() === fromToken.toLowerCase() &&
            o.toToken?.toLowerCase() === toToken.toLowerCase() &&
            o.bookTime && new Date(o.bookTime).getTime() >= since - 60_000)
          .sort((a, b) => new Date(b.bookTime) - new Date(a.bookTime))[0];
        const hit = done(exact) ? exact : done(fallback) ? fallback : (exact || fallback);
        if (done(hit)) return hit;
      } catch { /* keep polling */ }
      const D = [700, 900, 1200, 1600, 2000, 3000, 5000];
      await sleep(D[Math.min(i, D.length - 1)]);
    }
    return null;
  }

  // Orders held for App confirmation: poll wallet history until they land.
  async function trackPendingConfirmation(orderId, meta, startedAt = Date.now()) {
    if (!orderId || trackedPending.has(orderId)) return;
    trackedPending.add(orderId);
    const started = Number(startedAt) || Date.now();
    state.pendingOrders[orderId] = { meta: meta || null, started };
    saveState();
    log('needs_app_confirmation', { orderId, to: meta?.to });
    const done = () => {
      if (state.pendingOrders[orderId]) { delete state.pendingOrders[orderId]; saveState(); }
    };
    try {
      const isApprove = String(meta?.inputData || '').startsWith('0x095ea7b3');
      const hay = (String(meta?.inputData || '') + String(meta?.to || '')).toLowerCase();
      for (let i = 0; i < 60; i++) {
        await sleep(i < 10 ? 6000 : 15000);
        let j;
        try { j = await baw(['wallet', 'tx-history', '--binanceChainId', chainId, '--size', '20']); } catch { continue; }
        const txs = j?.data?.transactions || [];
        const hit = txs.find((t) => {
          const at = new Date(t.txTime).getTime();
          if (!(at >= started - 60_000)) return false;
          if (!['confirmed', 'failed', 'rejected'].includes(t.status)) return false;
          if (isApprove) return t.txType === 'approve';
          const addrs = (t.txHashList || []).flatMap((h) => [
            ...(h.instructions?.send || []),
            ...(h.instructions?.receive || []),
          ]).map((x) => String(x.tokenInfo?.contractAddress || '').toLowerCase().slice(2)).filter(Boolean);
          return ['contract_call', 'swap'].includes(t.txType) && addrs.some((a) => a !== 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' && hay.includes(a));
        });
        if (!hit) continue;
        if (hit.status === 'confirmed') {
          const flows = (hit.txHashList || []).flatMap((h) => [
            ...(h.instructions?.send || []).map((x) => `-${x.amount} ${x.tokenInfo?.symbol || '?'}`),
            ...(h.instructions?.receive || []).map((x) => `+${x.amount} ${x.tokenInfo?.symbol || '?'}`),
          ]);
          log('app_confirmed', { orderId, txHash: hit.txHash, flows });
          await notify(`✅ App 确认后已成交\n${flows.join('\n')}\n订单 ${orderId}${hit.txHash ? `\ntx ${hit.txHash}` : ''}`);
          for (const h of pendingHandlers) { try { await h(orderId, meta, hit); } catch { /* ignore */ } }
        } else {
          log('app_rejected', { orderId, status: hit.status });
          await notify(`❌ App 确认后执行失败(${hit.status})\n订单 ${orderId}`);
        }
        done();
        return;
      }
      await notify(`⏳ 订单 ${orderId} 一直没查到成交,可能被拒绝或已过期,请到 App 查看`);
      done();
    } catch {
      done();
    } finally {
      trackedPending.delete(orderId);
    }
  }

  function resumePending() {
    for (const [orderId, p] of Object.entries(state.pendingOrders || {})) {
      if (Date.now() - Number(p?.started || 0) > 30 * 60_000) { delete state.pendingOrders[orderId]; continue; }
      void trackPendingConfirmation(orderId, p?.meta || null, p?.started || Date.now());
    }
    saveState();
  }

  // An App-confirmation order touching this token (blocks duplicate trades).
  function pendingOrderFor(token) {
    const needle = String(token || '').toLowerCase().slice(2);
    if (!needle) return null;
    for (const [orderId, p] of Object.entries(state.pendingOrders || {})) {
      if (Date.now() - Number(p?.started || 0) > 3 * 60_000) continue;
      const hay = (String(p?.meta?.inputData || '') + String(p?.meta?.to || '')).toLowerCase();
      if (hay.includes(needle)) return orderId;
    }
    return null;
  }

  return {
    cli: CLI,
    baw,
    preview,
    execute,
    waitDexOrder,
    trackPendingConfirmation,
    resumePending,
    pendingOrderFor,
    onPendingFilled: (fn) => pendingHandlers.push(fn),
  };
}

/** Balance changes for `owner` from a preview: Map(asset(lowercase, NATIVE for BNB) -> bigint). */
export function previewChanges(pv, owner) {
  const out = new Map();
  const me = String(owner).toLowerCase();
  for (const b of pv?.data?.simulationResult?.balanceChanges || []) {
    if (b.owner && String(b.owner).toLowerCase() !== me) continue;
    if (b.tokenType !== 'Native' && b.tokenType !== 'Erc20') continue;
    const asset = b.tokenType === 'Native' ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : String(b.contractAddress).toLowerCase();
    let v;
    try {
      // `change` is a JSON number; large values lose precision but we only
      // use it to size minOut (after a slippage haircut), never as an exact balance.
      v = BigInt(typeof b.change === 'string' ? b.change.split('.')[0] : Math.trunc(Number(b.change)).toLocaleString('fullwide', { useGrouping: false }));
    } catch { continue; }
    out.set(asset, (out.get(asset) || 0n) + v);
  }
  return out;
}

export const previewRisky = (pv) => (pv?.data?.risks?.riskDetails || []).length > 0;
