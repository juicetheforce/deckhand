/**
 * Offline test for the credentials file (src/credentials.ts), against a
 * scratch state directory:
 *
 * - **changes made at the same moment all land, one after another**: a Twitch
 *   refresh and an OBS save together, and many of each, leave a file that
 *   parses and holds every change — before the lock, two writes shared one
 *   temp file, and the file left behind was often not JSON at all;
 * - the newest refresh token is the one kept, however the writes overlap;
 * - a change that fails does not stop the ones after it;
 * - a temp file left over from a crash does not block a write;
 * - the file is 0600 and no temp file is left behind.
 *
 *   npm run build:ts && node scripts/smoke-credentials.mjs
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATE = await fs.mkdtemp(path.join(os.tmpdir(), 'deckhand-smoke-credentials-'));
process.env.DECKHAND_STATE_DIR = STATE;
const credentials = await import(path.join(REPO, 'dist/credentials.js'));
const FILE = path.join(STATE, 'credentials.json');

let failures = 0;
const check = (name, ok) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const readJson = async () => {
  try {
    return JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    return null;
  }
};
const link = (refreshToken) => ({ clientId: 'client', userId: 'user', login: 'someone', scopes: ['a'], refreshToken, accessToken: 'access' });

try {
  // One refresh and one OBS save at once: the case the audit reproduced.
  let allLanded = true;
  let allParsed = true;
  let anyRefused = false;
  for (let round = 0; round < 50; round++) {
    const results = await Promise.allSettled([
      credentials.setTwitchCredentials(link(`refresh-${round}`)),
      credentials.setObsCredentials({ host: 'localhost', port: 4455, password: `password-${round}` }),
    ]);
    if (results.some((r) => r.status === 'rejected')) anyRefused = true;
    const file = await readJson();
    if (file === null) allParsed = false;
    else if (file.twitch?.refreshToken !== `refresh-${round}` || file.obs?.password !== `password-${round}`) allLanded = false;
  }
  check('a Twitch refresh and an OBS save at the same moment: neither is refused (50 rounds)', !anyRefused);
  check('the file parses after every round', allParsed);
  check('and holds both changes every round', allLanded);

  // Many writers at once, every section: each one lands, in the order asked.
  const many = [];
  for (let i = 0; i < 30; i++) {
    if (i % 3 === 0) many.push(credentials.setTwitchCredentials(link(`many-${i}`)));
    else if (i % 3 === 1) many.push(credentials.setObsCredentials({ password: `obs-${i}` }));
    else many.push(credentials.setVtsCredentials({ port: 8001, token: `vts-${i}` }));
  }
  const settled = await Promise.allSettled(many);
  check('30 changes at once across three sections: none refused', settled.every((r) => r.status === 'fulfilled'));
  const after = await readJson();
  check('the last change asked for in each section is the one kept', after?.twitch?.refreshToken === 'many-27' && after?.obs?.password === 'obs-28' && after?.vts?.token === 'vts-29');
  check('reading it back through the module agrees', (await credentials.twitchCredentials())?.refreshToken === 'many-27');

  // A remove in the middle of changes: ordered like any other change.
  await Promise.all([
    credentials.setObsCredentials({ password: 'before-remove' }),
    credentials.removeObsCredentials(),
    credentials.setTwitchCredentials(link('alongside-remove')),
  ]);
  const removed = await readJson();
  check('a remove among other changes: OBS gone, the Twitch change kept', removed !== null && !('obs' in removed) && removed.twitch?.refreshToken === 'alongside-remove');

  // A change that fails (the file cannot be parsed) does not stop the queue.
  await fs.writeFile(FILE, '{ not json', { mode: 0o600 });
  const broken = await Promise.allSettled([credentials.setObsCredentials({ password: 'x' })]);
  check('a change that fails is refused', broken[0].status === 'rejected');
  await fs.writeFile(FILE, '{}\n', { mode: 0o600 });
  await credentials.setObsCredentials({ password: 'after-failure' });
  check('and the next change still runs', (await readJson())?.obs?.password === 'after-failure');

  // A temp file left by a crash (the name a write before this fix used) does not block the next write.
  await fs.writeFile(`${FILE}.${process.pid}.tmp`, 'left over', { mode: 0o600 });
  const past = await Promise.allSettled([credentials.setObsCredentials({ password: 'past-leftover' })]);
  check('a temp file left over from a crash does not block a write', past[0].status === 'fulfilled' && (await readJson())?.obs?.password === 'past-leftover');
  await fs.rm(`${FILE}.${process.pid}.tmp`, { force: true });

  const mode = (await fs.stat(FILE)).mode & 0o777;
  check(`the file is 0600 (${mode.toString(8)})`, mode === 0o600);
  const left = (await fs.readdir(STATE)).filter((n) => n.endsWith('.tmp'));
  check('no temp file left behind', left.length === 0);
} finally {
  await fs.rm(STATE, { recursive: true, force: true });
}

console.log(failures === 0 ? '\ncredentials: all checks passed' : `\ncredentials: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
