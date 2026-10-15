// The update check (src/shared/updates.ts, src/main/updates.ts): which
// version is newer, which answers name a release, and what the checker asks
// and shows — against a local server standing in for GitHub.

import assert from 'node:assert/strict';
import http from 'node:http';

const { isNewer, parseVersion, releaseFrom } = await import('../src/shared/updates.js');
const { UpdateChecker } = await import('../src/main/updates.js');

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${String((err as Error).stack ?? err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

await check('versions: a tag, a developer install, and nothing to read', () => {
  assert.deepEqual(parseVersion('v0.7.1'), [0, 7, 1]);
  assert.deepEqual(parseVersion('v0.7.0-3-gf2765f2'), [0, 7, 0]);
  assert.equal(parseVersion('a development build'), null);
});

await check('newer: by each number in turn, never by text order', () => {
  assert.equal(isNewer('v0.7.1', 'v0.7.0'), true);
  assert.equal(isNewer('v0.10.0', 'v0.9.9'), true);
  assert.equal(isNewer('v1.0.0', 'v0.99.99'), true);
  assert.equal(isNewer('v0.7.0', 'v0.7.0'), false);
  assert.equal(isNewer('v0.6.9', 'v0.7.0'), false);
});

await check('a developer install between releases counts as the release it follows; a checkout is never told to update', () => {
  assert.equal(isNewer('v0.7.0', 'v0.7.0-3-gf2765f2'), false);
  assert.equal(isNewer('v0.7.1', 'v0.7.0-3-gf2765f2'), true);
  assert.equal(isNewer('v0.7.1', null), false);
  assert.equal(isNewer('v0.7.1', 'not a version'), false);
});

await check("an answer names a release only with a plain tag and this repository's page for exactly that tag", () => {
  const page = 'https://github.com/juicetheforce/deckhand/releases/tag/v0.7.1';
  assert.deepEqual(releaseFrom({ tag_name: 'v0.7.1', html_url: page }), { version: 'v0.7.1', url: page });
  assert.equal(releaseFrom({ tag_name: 'v0.7.1', html_url: 'https://evil.example/releases/tag/v0.7.1' }), null);
  assert.equal(releaseFrom({ tag_name: 'v0.7.1', html_url: 'https://github.com/juicetheforce/deckhand/releases/tag/v0.7.2' }), null);
  assert.equal(releaseFrom({ tag_name: 'v0.7.1-rc1', html_url: 'https://github.com/juicetheforce/deckhand/releases/tag/v0.7.1-rc1' }), null);
  assert.equal(releaseFrom({ message: 'Not Found' }), null);
  assert.equal(releaseFrom(null), null);
});

// A stand-in for GitHub: answers with whatever `answer` is now, and counts requests.
let answer: { status: number; body: string } = { status: 200, body: JSON.stringify({ tag_name: 'v0.8.0', html_url: 'https://github.com/juicetheforce/deckhand/releases/tag/v0.8.0' }) };
let requests = 0;
const server = http.createServer((_req, res) => {
  requests++;
  res.writeHead(answer.status, { 'content-type': 'application/json' });
  res.end(answer.body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/releases/latest`;

function checker(options: { version?: string | null; enabled?: boolean; url?: string | null } = {}) {
  const seen: string[] = [];
  const it = new UpdateChecker({
    url: options.url === undefined ? url : options.url,
    version: () => (options.version === undefined ? 'v0.7.1' : options.version),
    enabled: async () => options.enabled ?? true,
    onChange: (state) => seen.push(state.status),
  });
  return { it, seen };
}

const quietly = async (fn: () => Promise<void>) => {
  const error = console.error;
  console.error = () => undefined;
  try {
    await fn();
  } finally {
    console.error = error;
  }
};

await check('a newer release: available, with its version and page', async () => {
  const { it, seen } = checker();
  const before = requests;
  await it.check();
  assert.equal(requests, before + 1);
  assert.deepEqual(it.state(), { enabled: true, status: 'available', latest: 'v0.8.0', url: 'https://github.com/juicetheforce/deckhand/releases/tag/v0.8.0' });
  assert.deepEqual(seen, ['checking', 'available']);
});

await check('the same release as installed: current, nothing to show', async () => {
  const { it } = checker({ version: 'v0.8.0' });
  await it.check();
  assert.equal(it.state().status, 'current');
  assert.equal(it.state().url, null);
});

await check('switched off: nothing asked at all', async () => {
  const { it } = checker({ enabled: false });
  const before = requests;
  await it.check();
  assert.equal(requests, before);
  assert.equal(it.state().status, 'off');
});

await check('an editor run from a checkout (no version), or a check naming no server: nothing asked', async () => {
  const before = requests;
  const fromCheckout = checker({ version: null });
  await fromCheckout.it.check();
  const noServer = checker({ url: null });
  await noServer.it.check();
  assert.equal(requests, before);
  assert.equal(fromCheckout.it.state().status, 'idle');
  assert.equal(noServer.it.state().status, 'idle');
});

await check('two checks at once ask once', async () => {
  const { it } = checker();
  const before = requests;
  await Promise.all([it.check(), it.check()]);
  assert.equal(requests, before + 1);
});

await check('an error, or an answer that names no release: failed, and nothing shown', async () => {
  answer = { status: 500, body: 'oops' };
  const failed = checker();
  await quietly(() => failed.it.check());
  assert.deepEqual(failed.it.state(), { enabled: true, status: 'failed', latest: null, url: null });
  answer = { status: 200, body: JSON.stringify({ tag_name: 'v9.0.0', html_url: 'https://elsewhere.example/' }) };
  const odd = checker();
  await quietly(() => odd.it.check());
  assert.equal(odd.it.state().status, 'failed');
});

await check('turned off forgets what was found; turned on asks again at once', async () => {
  answer = { status: 200, body: JSON.stringify({ tag_name: 'v0.8.0', html_url: 'https://github.com/juicetheforce/deckhand/releases/tag/v0.8.0' }) };
  const { it } = checker();
  await it.check();
  await it.setEnabled(false);
  assert.deepEqual(it.state(), { enabled: false, status: 'off', latest: null, url: null });
  const before = requests;
  await it.setEnabled(true);
  assert.equal(requests, before + 1);
  assert.equal(it.state().status, 'available');
});

server.close();
console.log(failures === 0 ? 'updates: all checks passed' : `updates: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
