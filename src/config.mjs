// Load and validate config.json, fill defaults, fail with Chinese messages.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = process.env.COPYTRADER_CONFIG || path.join(ROOT, 'config.json');

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const DEFAULTS = {
  chainId: '56',
  sizeRatio: 0.2,
  slippagePct: 15,
  copy: {
    autoExecute: false,
    buys: true,
    sells: true,
    minBuyBnb: 0.001,
    maxBuyBnb: null,
    skipIfNoMinOut: false,
    failCooldownMs: 60_000,
    sellMinRatioBps: 100,
    sellFullExitBps: 9900,
    sellMarketFallback: true,
    buyMarketFallback: true,
    preApproveSell: true,
  },
  market: { slippagePct: 15, mev: true, gasLevel: 'MEDIUM' },
  rpc: {
    http: [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed.binance.org/',
      'https://bsc-dataseed1.defibit.io/',
    ],
    wss: ['wss://bsc-rpc.publicnode.com'],
    pollMs: 1000,
    headStallMs: 3000,
    timeoutMs: 8000,
  },
  telegram: { enabled: false, token: '', chatId: '' },
  bawPath: '',
};

function merge(base, over) {
  if (over === undefined) return base;
  if (base && typeof base === 'object' && !Array.isArray(base) && over && typeof over === 'object' && !Array.isArray(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
    return out;
  }
  return over;
}

export function loadConfig(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到配置文件 ${file}\n请先复制 config.example.json 为 config.json 并填写`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`config.json 不是合法 JSON:${e.message}`);
  }
  // Keys starting with "_" are comments in the example file.
  for (const k of Object.keys(raw)) if (k.startsWith('_')) delete raw[k];
  const cfg = merge(DEFAULTS, raw);
  return validate(cfg);
}

export function validate(cfg) {
  const errs = [];
  const wallet = String(cfg.wallet || '');
  if (!ADDR_RE.test(wallet)) errs.push('wallet 必须是你的 AI 钱包 BSC 地址(0x 开头 40 位十六进制)');
  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) errs.push('targets 至少填写一个跟单目标');
  const seen = new Set();
  for (const [i, t] of (cfg.targets || []).entries()) {
    if (!ADDR_RE.test(String(t?.address || ''))) errs.push(`targets[${i}].address 不是合法地址`);
    const a = String(t?.address || '').toLowerCase();
    if (seen.has(a)) errs.push(`targets[${i}].address 重复`);
    seen.add(a);
    if (a === wallet.toLowerCase()) errs.push(`targets[${i}] 不能是你自己的钱包`);
    if (t?.sizeRatio != null && !(Number(t.sizeRatio) > 0)) errs.push(`targets[${i}].sizeRatio 必须大于 0`);
  }
  if (!(Number(cfg.sizeRatio) > 0)) errs.push('sizeRatio 必须大于 0');
  const slip = Number(cfg.slippagePct);
  if (!(slip > 0 && slip < 100)) errs.push('slippagePct 必须在 0 到 100 之间(例:15 表示 15%)');
  const mslip = Number(cfg.market.slippagePct);
  if (!(mslip > 0 && mslip <= 100)) errs.push('market.slippagePct 必须在 0 到 100 之间');
  if (cfg.copy.maxBuyBnb != null && !(Number(cfg.copy.maxBuyBnb) > 0)) errs.push('copy.maxBuyBnb 填数字或 null');
  if (!Array.isArray(cfg.rpc.http) || !cfg.rpc.http.length) errs.push('rpc.http 至少一个 HTTP RPC');
  if (cfg.telegram.enabled && (!cfg.telegram.token || !cfg.telegram.chatId)) {
    errs.push('telegram.enabled=true 时必须填写 telegram.token 和 telegram.chatId');
  }
  if (errs.length) throw new Error(`配置有误:\n- ${errs.join('\n- ')}`);

  cfg.wallet = wallet.toLowerCase();
  cfg.chainId = String(cfg.chainId);
  cfg.targets = cfg.targets.map((t) => ({
    address: String(t.address).toLowerCase(),
    label: t.label || String(t.address).slice(0, 8),
    sizeRatio: Number(t.sizeRatio ?? cfg.sizeRatio),
  }));
  return cfg;
}
