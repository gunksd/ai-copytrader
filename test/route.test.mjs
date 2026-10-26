import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  W, padAddr, splitWords, discoveryCandidates, buildRouteTemplate,
  routeCandidates, templateFrom, setWord, applySlippage, refreshPackedTimestamps,
} from '../src/route.mjs';

const ME = '0x1111111111111111111111111111111111111111';
const TGT = '0x2222222222222222222222222222222222222222';
const TOK = '0x3333333333333333333333333333333333333333';
const NOW = 1_800_000_000;

// swapExactETHForTokensSupportingFee(minOut, path, to, deadline)
function pancakeBuy(minOut, to, deadline, amountWord = null) {
  return '0xb6f9de95' + W(amountWord ?? minOut) + W(0x80) + padAddr(to) + W(deadline)
    + W(2) + padAddr('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') + padAddr(TOK);
}

test('splitWords splits selector, words, tail', () => {
  const { sel, words, tail } = splitWords('0xdeadbeef' + W(1) + W(2) + 'abcd');
  assert.equal(sel, '0xdeadbeef');
  assert.equal(words.length, 2);
  assert.equal(tail, 'abcd');
});

test('applySlippage: minOut = expected*(1-slip)', () => {
  assert.equal(applySlippage(1000n, 15), 850n);
  assert.equal(applySlippage(1000n, 0), 1000n);
});

test('discoveryCandidates rewrites recipient to us and zeroes minOut (native buy)', () => {
  const tx = { from: TGT, to: '0x10ed43c718714eb63d5aa57b78b54704e256024e', value: '0x' + (10n ** 18n).toString(16), input: pancakeBuy(500000000000000000000000n, TGT, 1_700_000_000) };
  const cands = discoveryCandidates(tx, { me: ME, keep: TOK, refAmount: 10n ** 18n, ourAmount: 2n * 10n ** 17n, valueCarried: true }, NOW);
  assert.ok(cands.length >= 1);
  const c0 = cands[0];
  // recipient word is us
  assert.ok(c0.data.includes(padAddr(ME)));
  // target address is gone
  assert.ok(!c0.data.includes(TGT.slice(2)));
  // deadline refreshed
  const { words } = splitWords(c0.data);
  assert.equal(BigInt('0x' + words[3]), BigInt(NOW + 600));
  // minOut word zeroed and reported as a slot
  assert.equal(BigInt('0x' + words[0]), 0n);
  assert.ok(c0.minOutSlots.includes(0));
});

test('discoveryCandidates: exact-amount word gets our amount', () => {
  // amount word equals tx.value (ERC20-style amountIn mirrored too)
  const amt = 10n ** 18n;
  const tx = { from: TGT, to: TGT, value: '0x' + amt.toString(16), input: '0xaabbccdd' + W(amt) + W(500n) + padAddr(TOK) + padAddr(TGT) };
  const cands = discoveryCandidates(tx, { me: ME, keep: TOK, refAmount: amt, ourAmount: amt / 5n, valueCarried: false }, NOW);
  const { words } = splitWords(cands[0].data);
  assert.equal(BigInt('0x' + words[0]), amt / 5n);        // our amount
  assert.ok(cands[0].amountWords.includes(0));
  assert.equal(BigInt('0x' + words[2]).toString(16).padStart(40, '0'), TOK.slice(2)); // token kept
});

test('discoveryCandidates keeps small flags and fee tiers', () => {
  // word0 fee tier (kept), word1 flag (kept), word2 a real amount (rewritten)
  const tx = { from: TGT, to: TGT, value: '0x0', input: '0xaabbccdd' + W(3000n) + W(1n) + W(10n ** 18n) + padAddr(TOK) };
  const cands = discoveryCandidates(tx, { me: ME, keep: TOK, refAmount: 10n ** 18n, ourAmount: 2n * 10n ** 17n, valueCarried: false }, NOW);
  const hit = cands.find((c) => c.amountWords.includes(2)) || cands[0];
  const { words } = splitWords(hit.data);
  assert.equal(BigInt('0x' + words[0]), 3000n); // fee tier kept
  assert.equal(BigInt('0x' + words[1]), 1n);    // flag kept
});

test('buildRouteTemplate + routeCandidates round-trip restores amount', () => {
  const amt = 10n ** 18n;
  const tx = { from: TGT, to: '0xRouter000000000000000000000000000000beef'.toLowerCase(), value: '0x' + amt.toString(16), input: pancakeBuy(500n, TGT, 1_700_000_000, amt) };
  const tpl = buildRouteTemplate(tx, { me: ME, keep: TOK, refAmount: amt }, NOW);
  assert.ok(tpl.amountWords.includes(0));
  const cands = routeCandidates(tpl, 7n, NOW);
  const filled = cands.find((c) => c.amountWords.includes(0));
  const { words } = splitWords(filled.data);
  assert.equal(BigInt('0x' + words[0]), 7n);
  assert.equal(BigInt('0x' + words[3]), BigInt(NOW + 600)); // deadline refreshed again
});

test('templateFrom zeroes amount and minOut words', () => {
  const amt = 10n ** 18n;
  const cand = { data: '0xaabbccdd' + W(amt) + W(850n) + padAddr(TOK), amountWords: [0], minOutSlots: [1], minOutWord: 1 };
  const tpl = templateFrom(TGT, cand);
  const { words } = splitWords(tpl.data);
  assert.equal(BigInt('0x' + words[0]), 0n);
  assert.equal(BigInt('0x' + words[1]), 0n);
  assert.equal(tpl.minOutWord, 1);
});

test('setWord replaces exactly one word', () => {
  const d = '0xaabbccdd' + W(1n) + W(2n);
  const out = setWord(d, 1, 99n);
  const { words } = splitWords(out);
  assert.equal(BigInt('0x' + words[0]), 1n);
  assert.equal(BigInt('0x' + words[1]), 99n);
});

test('refreshPackedTimestamps bumps a mid-word packed deadline', () => {
  const refTs = 1_700_000_000;
  const packed = 'ff' + refTs.toString(16).padStart(8, '0') + 'ee'; // deadline between filler bytes
  const out = refreshPackedTimestamps('0xaabbccdd' + packed, refTs, NOW);
  const fresh = (NOW + 600).toString(16).padStart(8, '0');
  assert.ok(out.includes(fresh));
  assert.ok(out.startsWith('0xaabbccddff'));
});

test('refreshPackedTimestamps leaves non-timestamp bytes alone', () => {
  const d = '0xaabbccdd' + W(12345n);
  assert.equal(refreshPackedTimestamps(d, 1_700_000_000, NOW), d);
});
