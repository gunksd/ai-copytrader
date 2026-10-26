import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAction } from '../src/action.mjs';
import { NATIVE, TRANSFER, WBNB } from '../src/chain.mjs';

const TGT = '0x2222222222222222222222222222222222222222';
const TOK = '0x3333333333333333333333333333333333333333';
const POOL = '0x4444444444444444444444444444444444444444';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const topic = (a) => '0x' + a.slice(2).padStart(64, '0');
const amt = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const xfer = (token, from, to, v) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: amt(v) });

test('native buy: value out, token in => buy', () => {
  const tx = { from: TGT, to: POOL, value: '0x' + (10n ** 18n).toString(16), input: '0xb6f9de95' };
  const receipt = { status: '0x1', logs: [xfer(TOK, POOL, TGT, 1000n)] };
  const a = detectAction(tx, receipt);
  assert.equal(a.kind, 'buy');
  assert.equal(a.token, TOK);
  assert.equal(a.spent.token, NATIVE);
  assert.equal(a.spent.raw, 10n ** 18n);
  assert.equal(a.received.raw, 1000n);
});

test('stable buy: USDT out, token in => buy with stable', () => {
  const tx = { from: TGT, to: POOL, value: '0x0', input: '0x38893cb5' };
  const receipt = { status: '0x1', logs: [xfer(USDT, TGT, POOL, 500n), xfer(TOK, POOL, TGT, 1000n)] };
  const a = detectAction(tx, receipt);
  assert.equal(a.kind, 'buy');
  assert.equal(a.spent.token, USDT);
  assert.equal(a.spent.raw, 500n);
});

test('sell: token out, WBNB in => sell', () => {
  const tx = { from: TGT, to: POOL, value: '0x0', input: '0x791ac947' };
  const receipt = { status: '0x1', logs: [xfer(TOK, TGT, POOL, 1000n), xfer(WBNB, POOL, TGT, 7n)] };
  const a = detectAction(tx, receipt);
  assert.equal(a.kind, 'sell');
  assert.equal(a.token, TOK);
  assert.equal(a.spent.raw, 1000n);
  assert.equal(a.received.token, WBNB);
});

test('sell for native BNB (internal transfer): provided via nativeIn', () => {
  const tx = { from: TGT, to: POOL, value: '0x0', input: '0x12345678' };
  const receipt = { status: '0x1', logs: [xfer(TOK, TGT, POOL, 1000n)] };
  const a = detectAction(tx, receipt, 5n * 10n ** 17n);
  assert.equal(a.kind, 'sell');
  assert.equal(a.received.token, NATIVE);
  assert.equal(a.received.raw, 5n * 10n ** 17n);
});

test('plain transfer is not a trade', () => {
  const tx = { from: TGT, to: TOK, value: '0x0', input: '0xa9059cbb' + '0'.repeat(128) };
  const receipt = { status: '0x1', logs: [xfer(TOK, TGT, POOL, 1000n)] };
  assert.equal(detectAction(tx, receipt).kind, 'none');
});

test('approve is not a trade', () => {
  const tx = { from: TGT, to: TOK, value: '0x0', input: '0x095ea7b3' + '0'.repeat(128) };
  assert.equal(detectAction(tx, { status: '0x1', logs: [] }).kind, 'none');
});

test('reverted tx => none', () => {
  const tx = { from: TGT, to: POOL, value: '0x1', input: '0xb6f9de95' };
  assert.equal(detectAction(tx, { status: '0x0', logs: [] }).kind, 'none');
});

test('round-trip of same token nets out (refund) and is ignored', () => {
  const tx = { from: TGT, to: POOL, value: '0x0', input: '0x12345678' };
  const receipt = { status: '0x1', logs: [xfer(TOK, TGT, POOL, 1000n), xfer(TOK, POOL, TGT, 1000n)] };
  assert.equal(detectAction(tx, receipt).kind, 'none');
});

test('largest non-quote token wins when several move', () => {
  const OTHER = '0x5555555555555555555555555555555555555555';
  const tx = { from: TGT, to: POOL, value: amt(10n ** 18n), input: '0xb6f9de95' };
  const receipt = { status: '0x1', logs: [xfer(OTHER, POOL, TGT, 5n), xfer(TOK, POOL, TGT, 1000n)] };
  assert.equal(detectAction(tx, receipt).token, TOK);
});
