// The editor's actions on the decks run one at a time (src/main/one-at-a-time.ts):
// the daemon refuses a second socket action while one runs, so two page tabs
// clicked quickly lost the second click until the editor queued its own.
import assert from 'node:assert/strict';
import { oneAtATime } from '../src/main/one-at-a-time.js';

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

/** A stand-in for the daemon: refuses a call that arrives while another runs, as action.run does. */
function fakeDaemon() {
  let running = false;
  const order: string[] = [];
  return {
    order,
    async call(name: string, ms: number): Promise<string> {
      if (running) throw new Error('busy');
      running = true;
      order.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`end ${name}`);
      running = false;
      return name;
    },
  };
}

await check('two calls made together both run, the second after the first has finished', async () => {
  const daemon = fakeDaemon();
  const run = oneAtATime();
  const results = await Promise.all([run(() => daemon.call('second', 30)), run(() => daemon.call('main', 5))]);
  assert.deepEqual(results, ['second', 'main']);
  assert.deepEqual(daemon.order, ['start second', 'end second', 'start main', 'end main']);
});

await check('without it, the same two calls collide — what the queue is for', async () => {
  const daemon = fakeDaemon();
  const results = await Promise.allSettled([daemon.call('second', 30), daemon.call('main', 5)]);
  assert.equal(results[1].status, 'rejected');
});

await check('a call that fails does not stop the next, and its caller still gets the failure', async () => {
  const run = oneAtATime();
  const failed = run(() => Promise.reject(new Error('no such page')));
  const next = run(async () => 'main');
  await assert.rejects(failed, /no such page/);
  assert.equal(await next, 'main');
});

await check('calls run in the order they were made', async () => {
  const run = oneAtATime();
  const seen: number[] = [];
  await Promise.all([30, 1, 15].map((ms, i) => run(() => new Promise<void>((resolve) => setTimeout(() => (seen.push(i), resolve()), ms)))));
  assert.deepEqual(seen, [0, 1, 2]);
});

console.log(failures === 0 ? '\none-at-a-time: all checks passed' : `\none-at-a-time: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
