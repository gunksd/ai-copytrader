import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/config.mjs';

const base = () => ({
  chainId: '56',
  wallet: '0x56c969C34d7b6510ad310874f6A404D978B3a616',
  targets: [{ address: '0x1111111111111111111111111111111111111111', label: 'A' }],
  sizeRatio: 0.2,
  slippagePct: 15,
  copy: { autoExecute: false, maxBuyBnb: null },
  market: { slippagePct: 15, mev: true, gasLevel: 'MEDIUM' },
  rpc: { http: ['https://x'], wss: [] },
  telegram: { enabled: false },
});

test('valid config lowercases addresses and inherits sizeRatio', () => {
  const c = validate(base());
  assert.equal(c.wallet, '0x56c969c34d7b6510ad310874f6a404d978b3a616');
  assert.equal(c.targets[0].sizeRatio, 0.2);
  assert.equal(c.targets[0].address, '0x1111111111111111111111111111111111111111');
});

test('rejects bad wallet', () => {
  const c = base(); c.wallet = 'nope';
  assert.throws(() => validate(c), /wallet/);
});

test('rejects empty targets', () => {
  const c = base(); c.targets = [];
  assert.throws(() => validate(c), /targets/);
});

test('rejects a target equal to our wallet', () => {
  const c = base(); c.targets = [{ address: c.wallet }];
  assert.throws(() => validate(c), /自己/);
});

test('rejects slippage out of range', () => {
  const c = base(); c.slippagePct = 150;
  assert.throws(() => validate(c), /slippagePct/);
});

test('telegram enabled without token fails', () => {
  const c = base(); c.telegram = { enabled: true, token: '', chatId: '' };
  assert.throws(() => validate(c), /telegram/);
});

test('per-target sizeRatio overrides global', () => {
  const c = base(); c.targets[0].sizeRatio = 0.5;
  assert.equal(validate(c).targets[0].sizeRatio, 0.5);
});
