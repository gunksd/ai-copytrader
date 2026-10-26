// Logging (JSON lines, secrets redacted), runtime state and learned routes.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const DATA_DIR = process.env.COPYTRADER_DATA || ROOT;
const LOG_PATH = path.join(DATA_DIR, 'copytrader.log');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const ROUTES_PATH = path.join(DATA_DIR, 'routes.json');

const secrets = new Set();
export function addSecret(s) { if (s && String(s).length >= 8) secrets.add(String(s)); }
function redact(s) {
  let out = s;
  for (const v of secrets) out = out.split(v).join('***');
  return out;
}

let notifier = null;
export function setNotifier(fn) { notifier = fn; }

export function log(event, data = {}) {
  const line = redact(JSON.stringify({ ts: new Date().toISOString(), event, ...data }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* ignore */ }
  if (notifier) { try { notifier(event, data); } catch { /* alerting must never break trading */ } }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// processed: txHash -> ts; pendingOrders: orderId -> { meta, started }
export const state = readJson(STATE_PATH, {});
state.processed ||= {};
state.pendingOrders ||= {};
state.positions ||= {};
state.tgOffset ||= 0;

export function saveState() {
  const hashes = Object.keys(state.processed);
  if (hashes.length > 2000) for (const h of hashes.slice(0, hashes.length - 2000)) delete state.processed[h];
  try { writeJsonAtomic(STATE_PATH, state); } catch (e) { console.error('saveState failed', e.message); }
}

// learnedBuys: token -> route seen on a target buy (may not have worked yet)
// fastRoutes:  token -> route that we executed successfully
// sellRoutes:  token -> route seen on a target sell
export const routes = readJson(ROUTES_PATH, {});
routes.learnedBuys ||= {};
routes.fastRoutes ||= {};
routes.sellRoutes ||= {};

export function saveRoutes() {
  try { writeJsonAtomic(ROUTES_PATH, routes); } catch (e) { console.error('saveRoutes failed', e.message); }
}
