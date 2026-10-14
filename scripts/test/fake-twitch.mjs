/**
 * A fake Twitch for the tests: id.twitch.tv's OAuth endpoints and the Helix
 * requests Deckhand makes, on one local port — the daemon finds it through
 * DECKHAND_TWITCH_ID_URL (`${fake.url}/oauth2`) and DECKHAND_TWITCH_API_URL
 * (`${fake.url}/helix`). Modelled on what real Twitch did in the probe
 * (docs/code-state.md, "Twitch — session 1"), not on its docs where the two
 * differ:
 *
 *   - a poll sooner than the interval: `slow_down`, and the interval grows;
 *   - the token answer's scopes are `scope`, an array; validate's `scopes`;
 *   - a refresh gives a new pair, and the replaced access token still works;
 *   - a spent refresh token: 400 "Invalid refresh token" — and **sending one
 *     ends the whole link**: every token of it stops working;
 *   - revoking a refresh token ends the link; revoking an access token ends
 *     only that token;
 *   - a Cancel on Twitch's page is never seen: the code stays pending;
 *   - offline, a marker and a clip are refused with Twitch's own strings.
 *
 * What expiry answers is a guess (`expired_token`) until measured.
 *
 *   const twitch = await startFakeTwitch({ interval: 1 });
 *   twitch.url; twitch.requests;            // every request: { method, path, body }
 *   twitch.approve();                       // the person approves the code waiting (the latest)
 *   twitch.expire();                        // the code waiting expires
 *   twitch.expireAccess();                  // every access token lapses (401 from then on)
 *   twitch.refuseRefresh = true;            // Twitch's own fault: every refresh refused, nothing ended
 *   twitch.down = true;                     // every request answered 503
 *   twitch.live = true;                     // the channel is live
 *   twitch.dropChat = { code: 'msg_duplicate', message: '…' };   // the next messages are not sent
 *   twitch.chat;                            // messages sent: { broadcaster, sender, message }
 *   twitch.slowDowns;                       // polls answered slow_down: sooner than the interval
 *   twitch.linksAlive();                    // how many links still have a working refresh token
 *   await twitch.stop();
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const USER = { id: '151766307', login: 'fakestreamer' };

export async function startFakeTwitch({ interval = 1, expiresIn = 14000, clientId = 'wak2tnl8hoiznbfq5l8k2rvesfj1ea' } = {}) {
  /** Device codes: device_code → { userCode, scopes, interval, lastPoll, state: 'pending'|'approved'|'expired'|'used' }. */
  const codes = new Map();
  /** Links: one per approval, with every token it has issued. */
  const links = [];
  const token = (n) => randomBytes(n).toString('hex').slice(0, n);

  const twitch = {
    url: '',
    clientId,
    requests: [],
    chat: [],
    slowDowns: 0,
    live: false,
    down: false,
    refuseRefresh: false,
    dropChat: null,
    approve() {
      const waiting = [...codes.values()].filter((c) => c.state === 'pending').at(-1);
      if (!waiting) throw new Error('fake Twitch: no code waiting to approve');
      waiting.state = 'approved';
    },
    expire() {
      for (const c of codes.values()) if (c.state === 'pending') c.state = 'expired';
    },
    expireAccess() {
      for (const link of links) link.access.clear();
    },
    linksAlive: () => links.filter((l) => !l.ended).length,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };

  function newLink(scopes) {
    const link = { scopes, access: new Set(), refresh: null, spent: new Set(), ended: false };
    links.push(link);
    return issue(link);
  }
  function issue(link) {
    const access = token(30);
    const refresh = token(50);
    link.access.add(access);
    if (link.refresh) link.spent.add(link.refresh);
    link.refresh = refresh;
    return { access_token: access, expires_in: expiresIn, refresh_token: refresh, scope: link.scopes, token_type: 'bearer' };
  }
  const end = (link) => {
    link.ended = true;
    link.access.clear();
    link.refresh = null;
  };
  const byAccess = (t) => links.find((l) => !l.ended && l.access.has(t));

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://fake');
    const body = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    twitch.requests.push({ method: req.method, path: url.pathname, body });
    const reply = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    if (twitch.down) return reply(503, { error: 'Service Unavailable', status: 503, message: '' });

    if (url.pathname === '/oauth2/device' && req.method === 'POST') {
      if (body.client_id !== clientId) return reply(400, { status: 400, message: 'invalid client' });
      const deviceCode = token(40);
      const userCode = token(8).toUpperCase();
      codes.set(deviceCode, { userCode, scopes: String(body.scopes ?? '').split(' ').filter(Boolean), interval, lastPoll: 0, state: 'pending' });
      return reply(200, { device_code: deviceCode, expires_in: 1800, interval, user_code: userCode, verification_uri: `https://www.twitch.tv/activate?device-code=${userCode}` });
    }

    if (url.pathname === '/oauth2/token' && req.method === 'POST') {
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const code = codes.get(body.device_code);
        if (!code || code.state === 'used') return reply(400, { status: 400, message: 'invalid device code' });
        const now = Date.now();
        const early = now - code.lastPoll < code.interval * 1000;
        code.lastPoll = now;
        if (early) {
          twitch.slowDowns++;
          code.interval += 5;
          return reply(400, { status: 400, message: 'slow_down' });
        }
        if (code.state === 'expired') return reply(400, { status: 400, message: 'expired_token' });
        if (code.state === 'pending') return reply(400, { status: 400, message: 'authorization_pending' });
        code.state = 'used';
        return reply(200, newLink(code.scopes));
      }
      if (body.grant_type === 'refresh_token') {
        const invalid = () => reply(400, { status: 400, message: 'Invalid refresh token' });
        if (twitch.refuseRefresh) return invalid();
        const link = links.find((l) => l.refresh === body.refresh_token);
        if (link) return reply(200, issue(link));
        // A replaced refresh token sent again ends the whole link (measured).
        const replayed = links.find((l) => l.spent.has(body.refresh_token));
        if (replayed) end(replayed);
        return invalid();
      }
      return reply(400, { status: 400, message: 'unsupported grant_type' });
    }

    if (url.pathname === '/oauth2/validate') {
      const t = String(req.headers.authorization ?? '').replace(/^OAuth /, '');
      const link = byAccess(t);
      if (!link) return reply(401, { status: 401, message: 'invalid access token' });
      return reply(200, { client_id: clientId, login: USER.login, scopes: link.scopes, user_id: USER.id, expires_in: expiresIn });
    }

    if (url.pathname === '/oauth2/revoke' && req.method === 'POST') {
      const viaRefresh = links.find((l) => l.refresh === body.token);
      if (viaRefresh) end(viaRefresh);
      else byAccess(body.token)?.access.delete(body.token);
      return reply(200);
    }

    if (url.pathname.startsWith('/helix/')) {
      const t = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const link = req.headers['client-id'] === clientId ? byAccess(t) : undefined;
      if (!link) return reply(401, { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' });
      const limits = { 'Ratelimit-Limit': '800', 'Ratelimit-Remaining': '799', 'Ratelimit-Reset': String(Math.ceil(Date.now() / 1000) + 60) };
      if (url.pathname === '/helix/chat/messages' && req.method === 'POST') {
        if (twitch.dropChat) return reply(200, { data: [{ message_id: '', is_sent: false, drop_reason: twitch.dropChat }] }, limits);
        twitch.chat.push({ broadcaster: body.broadcaster_id, sender: body.sender_id, message: body.message });
        return reply(200, { data: [{ message_id: token(32), is_sent: true, drop_reason: null }] }, limits);
      }
      if (url.pathname === '/helix/streams/markers' && req.method === 'POST') {
        if (!twitch.live) return reply(404, { error: 'Not Found', status: 404, message: 'code:"BROADCASTER_NOT_LIVE" message:"Stream markers cannot be created when the channel is offline."' }, limits);
        return reply(200, { data: [{ id: token(8), created_at: new Date().toISOString(), description: body.description ?? '', position_seconds: 60 }] }, limits);
      }
      if (url.pathname === '/helix/clips' && req.method === 'POST') {
        if (!twitch.live) return reply(404, { error: 'Not Found', status: 404, message: 'Channel offline.' }, limits);
        return reply(202, { data: [{ id: token(12), edit_url: 'https://clips.twitch.tv/x/edit' }] }, limits);
      }
      return reply(404, { error: 'Not Found', status: 404, message: 'fake Twitch has no such endpoint' });
    }
    reply(404, { status: 404, message: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  twitch.url = `http://127.0.0.1:${server.address().port}`;
  return twitch;
}
