#!/usr/bin/env node
// BSC route copy-trader: follow target wallets by mirroring their own tx route.
//
//   node copytrader.mjs                 # run (dry-run unless config.copy.autoExecute=true)
//   node copytrader.mjs --dry-run       # force dry-run
//   node copytrader.mjs replay <txHash> # re-run decision logic on a historical tx (always dry-run)
//   node copytrader.mjs doctor          # check config / baw / RPC / WSS
//
// Behind a local proxy set NODE_USE_ENV_PROXY=1 plus HTTPS_PROXY/HTTP_PROXY (run.sh / run.cmd do this).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './src/config.mjs';
import { log, state, saveState, routes, saveRoutes, addSecret } from './src/store.mjs';
import { createRpc } from './src/rpc.mjs';
import { createChain, fmtUnits, NATIVE } from './src/chain.mjs';
import { createBaw } from './src/baw.mjs';
import { createCopier } from './src/copy.mjs';
import { createHeadSource } from './src/heads.mjs';
import { createTelegram } from './src/telegram.mjs';

const argv = process.argv.slice(2);
const mode = ['replay', 'doctor', 'run'].includes(argv[0]) ? argv[0] : 'run';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
addSecret(cfg.telegram.token);

const DRY_RUN = mode === 'replay' || argv.includes('--dry-run') || cfg.copy.autoExecute !== true;
const rpcErrAt = new Map();
const { rpc, batch } = createRpc(cfg.rpc.http, {
  timeoutMs: cfg.rpc.timeoutMs,
  onError: (url, e) => {
    if (Date.now() - (rpcErrAt.get(url) || 0) > 60_000) { rpcErrAt.set(url, Date.now()); log('rpc_error', { url, message: e.message }); }
  },
});
const chain = createChain({ rpc, batch, log });
const tg = createTelegram({ cfg, state, saveState, log });
const notify = (text) => tg.send(DRY_RUN ? `[dry-run] ${text}` : text);
const wallet = createBaw({ cliPath: cfg.bawPath, chainId: cfg.chainId, me: cfg.wallet, state, saveState, log, notify });
// replay only reads routes.json, never writes it.
const ratioArg = argv.indexOf('--ratio');
if (mode === 'replay' && ratioArg >= 0) cfg.sizeRatio = Number(argv[ratioArg + 1]);
const copier = createCopier({ cfg, chain, wallet, routes, saveRoutes: mode === 'replay' ? () => {} : saveRoutes, state, saveState: mode === 'replay' ? () => {} : saveState, log, notify, dryRun: DRY_RUN });

const short = (a) => `${String(a).slice(0, 6)}…${String(a).slice(-4)}`;

async function walletChecks() {
  const out = [];
  const st = await wallet.baw(['wallet', 'status']).catch((e) => ({ success: false, error: { message: e.message } }));
  out.push(['钱包连接', st?.data?.status === 'CONNECTED', st?.data?.status || st?.error?.message]);
  const ad = await wallet.baw(['wallet', 'address']).catch(() => null);
  const bsc = (ad?.data?.addresses || []).find((a) => String(a.binanceChainId) === cfg.chainId);
  out.push(['钱包地址一致', bsc && bsc.address.toLowerCase() === cfg.wallet, bsc ? bsc.address : '查不到 BSC 地址']);
  const se = await wallet.baw(['wallet', 'settings']).catch(() => null);
  const dm = se?.data?.devMode;
  out.push(['开发者模式(contract-call 必需)', !!dm?.enabled, dm ? `到期 ${dm.expiresAt} · 日限额 $${dm.dailyLimit} · 已用 $${Number(se.data.developerModeQuotaUsed || 0).toFixed(2)}` : '未知']);
  return out;
}

async function statusText() {
  const lines = [
    `模式 ${DRY_RUN ? 'dry-run(不下单)' : '实盘'}`,
    `区块 ${heads?.lastBlock ?? '-'} · WSS ${heads?.connected ? '已连接' : '未连接(轮询中)'}`,
    `目标:\n${cfg.targets.map((t) => `  ${t.label} ${short(t.address)} ×${t.sizeRatio}`).join('\n')}`,
    `滑点 ${cfg.slippagePct}% · 路由 ${Object.keys(routes.fastRoutes).length} 条已验证 / ${Object.keys(routes.learnedBuys).length} 条已学习 / ${Object.keys(routes.sellRoutes).length} 条卖出`,
  ];
  try {
    const bnb = await chain.balanceOf(NATIVE, cfg.wallet);
    lines.push(`BNB 余额 ${fmtUnits(bnb, 18)}`);
  } catch { /* ignore */ }
  try {
    for (const [name, ok, detail] of await walletChecks()) lines.push(`${ok ? '✅' : '❌'} ${name} ${detail || ''}`);
  } catch { lines.push('钱包状态查询失败'); }
  const pend = Object.keys(state.pendingOrders || {});
  if (pend.length) lines.push(`待 App 确认 ${pend.length} 单`);
  return lines.join('\n');
}

function fmtTradeResult(r, what) {
  if (!r) return `❌ ${what}失败`;
  if (r.ok && r.dry) return `🧪 dry-run:${what}已模拟通过,未下单${r.note ? `\n${r.note}` : ''}`;
  if (r.ok && r.pending) return `⏳ ${what}待 App 确认,订单 ${r.orderId}`;
  if (r.ok && r.market) return `✅ ${what}(聚合器)订单 ${r.orderId || r.order?.orderId || ''}${r.order?.txHash ? `\ntx ${r.order.txHash}` : ''}`;
  if (r.ok) return `✅ ${what}已发送\ntx ${r.txHash || r.orderId}${r.fill?.minOut ? `\nminOut ${r.fill.minOut}` : ''}`;
  return `❌ ${what}失败 ${r.stage ? `[${r.stage}] ` : ''}${r.error || ''}`;
}

// ---------- block handling ----------

const TARGET_SET = new Set(cfg.targets.map((t) => t.address));

async function onBlock(n) {
  const t0 = Date.now();
  const receipts = await chain.blockReceipts(n);
  const hits = receipts.filter((r) => TARGET_SET.has(String(r.from).toLowerCase()) && !state.processed[r.transactionHash]);
  if (!hits.length) return;
  // Receipts lack calldata/value: fetch the target txs in one batch.
  const txs = await batch(hits.map((r) => ({ method: 'eth_getTransactionByHash', params: [r.transactionHash] })));
  log('block_hits', { block: n, hits: hits.length, tFetch: Date.now() - t0 });
  await Promise.all(hits.map(async (r, i) => {
    const tx = txs[i]?.result;
    state.processed[r.transactionHash] = Date.now();
    if (!tx) { log('error', { where: 'getTx', tx: r.transactionHash }); return; }
    try {
      await copier.handleTx(tx, r);
    } catch (e) {
      log('error', { where: 'handleTx', tx: tx.hash, message: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
    }
  }));
  state.lastBlock = n;
  saveState();
}

let heads = null;

async function run() {
  acquireLock();
  if (!wallet.cli) {
    log('abort', { reason: '找不到 baw CLI,请先 npm i -g @binance/agentic-wallet,或在 config.bawPath 填 dist/index.js 路径' });
    process.exit(1);
  }
  if (!DRY_RUN) {
    const checks = await walletChecks();
    for (const [name, ok, detail] of checks) log(ok ? 'check_ok' : 'check_failed', { name, detail });
    if (!checks[0][1] || !checks[1][1]) {
      log('abort', { reason: '实盘模式下钱包未连接或地址与 config.wallet 不一致' });
      process.exit(1);
    }
  }
  let head = null;
  for (let i = 0; i < 10 && head == null; i++) {
    try { head = Number(await rpc('eth_blockNumber')); } catch { await new Promise((r) => setTimeout(r, 3000)); }
  }
  if (head == null) { log('abort', { reason: '连不上 BSC RPC(代理没开?)' }); process.exit(1); }
  const fromArg = argv.indexOf('--from-block');
  const from = fromArg >= 0 ? Number(argv[fromArg + 1]) : head + 1;
  log('start', {
    dryRun: DRY_RUN, wallet: cfg.wallet, slippagePct: cfg.slippagePct, fromBlock: from,
    targets: cfg.targets.map((t) => `${t.label}:${t.address}×${t.sizeRatio}`),
  });
  wallet.resumePending();
  heads = createHeadSource({
    wssUrls: cfg.rpc.wss, rpc, pollMs: cfg.rpc.pollMs, stallMs: cfg.rpc.headStallMs, log, onBlock,
  });
  heads.start(from);
  if (tg.enabled) {
    void tg.loop({
      status: statusText,
      buy: async (token, bnb) => fmtTradeResult(await copier.manualBuy(token, bnb), `买入 ${short(token)}`),
      sell: async (token, pct) => fmtTradeResult(await copier.manualSell(token, pct), `卖出 ${short(token)} ${pct}%`),
    });
    await tg.send(`🟢 跟单已启动(${DRY_RUN ? 'dry-run,不会下单' : '实盘'})\n目标 ${cfg.targets.length} 个 · 滑点 ${cfg.slippagePct}%\n/status 查看状态`);
  }
}

async function replay() {
  const hash = argv[1];
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) {
    console.error('用法:node copytrader.mjs replay <txHash> [--ratio 0.2]');
    process.exit(1);
  }
  const [txR, rcR] = await batch([
    { method: 'eth_getTransactionByHash', params: [hash] },
    { method: 'eth_getTransactionReceipt', params: [hash] },
  ]);
  const tx = txR.result;
  const receipt = rcR.result;
  if (!tx || !receipt) { console.error('查不到这笔交易'); process.exit(1); }
  log('replay', { tx: hash, from: tx.from, to: tx.to, block: Number(receipt.blockNumber), note: '按当前链上状态重新跑一遍决策,只 preview 不下单' });
  await copier.handleTx(tx, receipt, { replay: true });
}

async function doctor() {
  const rows = [];
  rows.push(['Node 版本 ≥ 22', Number(process.versions.node.split('.')[0]) >= 22, process.version]);
  rows.push(['WebSocket 内置', typeof WebSocket !== 'undefined', '']);
  rows.push(['baw CLI', !!wallet.cli, wallet.cli || '未找到']);
  for (const url of cfg.rpc.http) {
    const r = createRpc([url], { timeoutMs: 5000 });
    const t = Date.now();
    try {
      const n = Number(await r.rpc('eth_blockNumber'));
      const sim = await r.rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from: cfg.wallet, to: cfg.wallet, value: '0x0', data: '0x' }] }] }, 'latest']).then(() => true).catch(() => false);
      rows.push([`RPC ${url}`, true, `区块 ${n} · ${Date.now() - t}ms · simulateV1 ${sim ? '支持' : '不支持'}`]);
    } catch (e) { rows.push([`RPC ${url}`, false, e.message]); }
  }
  for (const url of cfg.rpc.wss) {
    const ok = await new Promise((resolve) => {
      let ws;
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(false); }, 8000);
      try {
        ws = new WebSocket(url);
        ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
        ws.onmessage = (e) => { if (String(e.data).includes('eth_subscription')) { clearTimeout(timer); ws.close(); resolve(true); } };
        ws.onerror = () => { clearTimeout(timer); resolve(false); };
      } catch { clearTimeout(timer); resolve(false); }
    });
    rows.push([`WSS ${url}`, ok, ok ? '收到 newHeads' : '连不上(会自动用轮询兜底)']);
  }
  if (wallet.cli) rows.push(...await walletChecks());
  rows.push(['Telegram', !cfg.telegram.enabled || tg.enabled, cfg.telegram.enabled ? '已启用' : '未启用']);
  rows.push(['下单模式', true, DRY_RUN ? 'dry-run(不会下单)' : '⚠️ 实盘(copy.autoExecute=true)']);
  for (const [name, ok, detail] of rows) console.log(`${ok ? '✅' : '❌'} ${name}  ${detail || ''}`);
  process.exit(rows.every((r) => r[1]) ? 0 : 1);
}

function acquireLock() {
  const LOCK = path.join(process.env.COPYTRADER_DATA || ROOT, 'copytrader.lock');
  try {
    const old = Number(fs.readFileSync(LOCK, 'utf8').trim());
    if (old && old !== process.pid) {
      try { process.kill(old, 0); console.error(`已有一个实例在运行(pid ${old})`); process.exit(1); } catch { /* stale */ }
    }
  } catch { /* no lock */ }
  fs.writeFileSync(LOCK, String(process.pid));
  const release = () => { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.unlinkSync(LOCK); } catch { /* ignore */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveState(); release(); process.exit(0); });
}

const main = { run, replay, doctor }[mode];
main().catch((e) => {
  log('fatal', { message: e.message, stack: e.stack });
  process.exit(1);
}).then(() => { if (mode === 'replay') setTimeout(() => process.exit(0), 200); });

