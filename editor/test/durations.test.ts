// The duration estimates (src/shared/durations.ts) against the runs they were
// derived from, measured through the real helper.
import assert from 'node:assert/strict';
import { COMBO_TAP_MS, SINGLE_TAP_MS, actionDurationMs, comboTapMs, formatDuration, textDurationMs } from '../src/shared/durations.js';

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

await check('text estimates land within 10% of the measured runs', () => {
  const measured: Array<[string, number]> = [
    ['hello world', 247],
    ['Hello World', 506],
    ['The Quick Brown Fox', 944],
    ['READY CHECK!', 1671],
  ];
  for (const [text, ms] of measured) {
    const estimate = textDurationMs(text)!;
    assert.ok(Math.abs(estimate - ms) / ms < 0.1, `${text}: estimate ${estimate.toFixed(0)} ms, measured ${ms} ms`);
  }
});

await check('a character the US layout cannot type gives no estimate', () => {
  assert.equal(textDurationMs('café'), null);
  assert.equal(textDurationMs(''), 0);
});

await check('a combo with a modifier takes the held timing; a bare key the tap', () => {
  assert.equal(comboTapMs('ctrl+1'), COMBO_TAP_MS);
  assert.equal(comboTapMs('f24'), SINGLE_TAP_MS);
  assert.equal(comboTapMs('ctrl+nosuchkey'), null);
});

await check('hotkey estimates follow src/actions/keyboard.ts: hold replaces the tap, repeats and sequences add its 30 ms gap; other actions count 0', () => {
  assert.equal(actionDurationMs({ type: 'hotkey', keys: 'ctrl+1' }), COMBO_TAP_MS);
  assert.equal(actionDurationMs({ type: 'hotkey', keys: 'f24', holdMs: 400 }), 400);
  assert.equal(actionDurationMs({ type: 'hotkey', keys: 'f24', repeat: 3 }), 3 * SINGLE_TAP_MS + 2 * 30);
  assert.equal(actionDurationMs({ type: 'hotkey', keys: ['ctrl+c', 'ctrl+v'] }), 2 * COMBO_TAP_MS + 2 * 30);
  assert.equal(actionDurationMs({ type: 'text', text: 'gg' }), textDurationMs('gg'));
  assert.equal(actionDurationMs({ type: 'audio.sink', node: 'x' }), 0);
  assert.equal(actionDurationMs({ type: 'hotkey' }), 0);
});

await check('durations read as estimates', () => {
  assert.equal(formatDuration(247), '245 ms');
  assert.equal(formatDuration(1671), '1.7 s');
});

console.log(failures === 0 ? '\ndurations: all checks passed' : `\ndurations: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
