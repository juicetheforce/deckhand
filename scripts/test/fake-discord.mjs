/**
 * A fake Discord desktop app for the offline tests: its local RPC on a Unix
 * socket — the frame format, HANDSHAKE and READY, AUTHORIZE, AUTHENTICATE,
 * the voice commands and their events — and its OAuth2 token endpoint on
 * HTTP. Never a real Discord: the socket is at a path the test chooses, and
 * the daemon is pointed at the HTTP side by DECKHAND_DISCORD_API_URL.
 *
 * It behaves as the stage 0 probe measured the real one (scope §7,
 * "Discord"): READY after `readyDelayMs`; an application ID it does not know
 * gets CLOSE 4000; a change arrives as VOICE_SETTINGS_UPDATE before the
 * reply; SUBSCRIBE VOICE_STATE_UPDATE sends everyone in the channel at once;
 * **a join brings no VOICE_CHANNEL_SELECT, a leave does**; the token
 * endpoint wants no secret, refuses a reused refresh token with
 * invalid_grant without ending the link, and rotates the refresh token.
 * Anything sent with a client_secret is refused and counted.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const frame = (op, body) => {
  const json = Buffer.from(JSON.stringify(body));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
};

export async function startFakeDiscord({ socketPath, clientId = '1290347718562041856', readyDelayMs = 0 } = {}) {
  const fake = {
    socketPath,
    clientId,
    readyDelayMs,
    /** Connections open now, and every one ever handshaken. */
    open: 0,
    handshakes: 0,
    /** Every command received, in order: { cmd, args, evt }. */
    commands: [],
    /** What the token endpoint received, without secrets: { grant, fields }. */
    tokenRequests: [],
    revoked: [],
    secretsSeen: 0,
    voice: { mute: false, deaf: false, mode: { type: 'VOICE_ACTIVITY', auto_threshold: true, threshold: -60, delay: 98.4 } },
    selfId: '153242564659642372',
    channelId: null,
    /** The people in each voice channel, as GET_SELECTED_VOICE_CHANNEL lists them. */
    channels: {
      'c-general': { name: 'General', guild_id: 'g-1', people: [{ id: '692523192819908688', nick: 'Theo', volume: 100 }] },
      'c-empty': { name: 'Empty', guild_id: 'g-1', people: [] },
    },
    guilds: [{ id: 'g-1', name: 'Test server' }, { id: 'g-2', name: 'Other' }],
    /** Tokens: the access tokens and refresh tokens it accepts now. */
    accessTokens: new Set(),
    refreshTokens: new Set(),
    /** AUTHORIZE's answer: 'approve', 'deny', 'missing-redirect', or 'hang' (never answers). */
    authorize: 'approve',
    /** The next AUTHENTICATE is refused whatever the token. */
    refuseAuthenticate: false,
    /** Codes given, with their PKCE challenge. */
    codes: new Map(),
    nextToken: 0,
  };
  const sockets = new Set();

  const issue = () => {
    const n = ++fake.nextToken;
    const access = `access-${n}`;
    const refresh = `refresh-${n}`;
    fake.accessTokens.add(access);
    fake.refreshTokens.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 604800, token_type: 'Bearer', scope: 'rpc rpc.voice.read rpc.voice.write' };
  };
  fake.issue = issue;

  const peopleIn = (channelId) =>
    (fake.channels[channelId]?.people ?? []).map((p) => ({
      nick: p.nick,
      mute: false,
      volume: p.volume,
      pan: { left: 1, right: 1 },
      voice_state: { mute: false, deaf: false, self_mute: false, self_deaf: false, suppress: false },
      user: { id: p.id, username: p.nick.toLowerCase(), global_name: p.nick },
    }));
  const selfState = () => ({ nick: 'riccochet', mute: false, volume: 100, pan: { left: 1, right: 1 }, user: { id: fake.selfId, username: 'riccochet78', global_name: 'riccochet' } });

  const server = net.createServer((socket) => {
    sockets.add(socket);
    fake.open++;
    const conn = { authed: false, subs: new Set(), socket };
    let buffer = Buffer.alloc(0);
    const send = (op, body) => socket.writable && socket.write(frame(op, body));
    conn.dispatch = (evt, data) => send(1, { cmd: 'DISPATCH', evt, data });
    const reply = (msg, data) => send(1, { cmd: msg.cmd, nonce: msg.nonce, evt: null, data });
    const error = (msg, code, message) => send(1, { cmd: msg.cmd, nonce: msg.nonce, evt: 'ERROR', data: { code, message } });
    socket.on('close', () => {
      sockets.delete(socket);
      fake.open--;
    });
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const op = buffer.readUInt32LE(0);
        const len = buffer.readUInt32LE(4);
        if (buffer.length < 8 + len) return;
        const msg = JSON.parse(buffer.subarray(8, 8 + len).toString() || '{}');
        buffer = buffer.subarray(8 + len);
        handle(op, msg);
      }
    });
    const handle = (op, msg) => {
      if (op === 0) {
        if (msg.client_id !== fake.clientId) {
          send(2, { code: 4000, message: 'Invalid Client ID' });
          socket.end();
          return;
        }
        fake.handshakes++;
        setTimeout(() => send(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1, config: { environment: 'production' }, user: { id: fake.selfId } } }), fake.readyDelayMs);
        return;
      }
      if (op !== 1) return;
      fake.commands.push({ cmd: msg.cmd, args: msg.args, evt: msg.evt });
      const args = msg.args ?? {};
      switch (msg.cmd) {
        case 'AUTHORIZE': {
          if (fake.authorize === 'hang') return;
          if (fake.authorize === 'deny') return error(msg, 5000, 'OAuth2 Error: access_denied: The resource owner or authorization server denied the request.');
          if (fake.authorize === 'missing-redirect') return error(msg, 5000, 'OAuth2 Error: invalid_request: Missing "redirect_uri" in request.');
          const code = `code-${fake.codes.size + 1}`;
          fake.codes.set(code, { challenge: args.code_challenge, method: args.code_challenge_method, clientId: args.client_id });
          return reply(msg, { code });
        }
        case 'AUTHENTICATE':
          if (fake.refuseAuthenticate || !fake.accessTokens.has(args.access_token)) return error(msg, 4009, 'Invalid access token');
          conn.authed = true;
          return reply(msg, { user: { id: fake.selfId, username: 'riccochet78', global_name: 'riccochet' }, scopes: ['rpc', 'rpc.voice.read', 'rpc.voice.write'], expires: new Date(Date.now() + 6e8).toISOString(), application: { id: fake.clientId, name: 'DeckHand' } });
      }
      if (!conn.authed) return error(msg, 4006, 'Not authenticated or invalid scope');
      switch (msg.cmd) {
        case 'GET_VOICE_SETTINGS':
          return reply(msg, { ...fake.voice });
        case 'SET_VOICE_SETTINGS': {
          if (typeof args.mute === 'boolean') fake.voice.mute = args.mute;
          if (typeof args.deaf === 'boolean') {
            fake.voice.deaf = args.deaf;
            if (args.deaf) fake.voice.mute = true;
          }
          if (args.mode?.type) fake.voice.mode = { ...fake.voice.mode, type: args.mode.type };
          fake.broadcast('VOICE_SETTINGS_UPDATE', { ...fake.voice });
          return reply(msg, { ...fake.voice });
        }
        case 'SUBSCRIBE': {
          const key = `${msg.evt}:${args.channel_id ?? ''}`;
          conn.subs.add(key);
          reply(msg, { evt: msg.evt });
          if (msg.evt === 'VOICE_SETTINGS_UPDATE') conn.dispatch('VOICE_SETTINGS_UPDATE', { ...fake.voice });
          if (msg.evt === 'VOICE_STATE_UPDATE') for (const p of [...peopleIn(args.channel_id), selfState()]) conn.dispatch('VOICE_STATE_UPDATE', p);
          return;
        }
        case 'UNSUBSCRIBE':
          conn.subs.delete(`${msg.evt}:${args.channel_id ?? ''}`);
          return reply(msg, { evt: msg.evt });
        case 'GET_SELECTED_VOICE_CHANNEL': {
          if (!fake.channelId) return reply(msg, null);
          const ch = fake.channels[fake.channelId];
          return reply(msg, { id: fake.channelId, name: ch.name, type: 2, guild_id: ch.guild_id, voice_states: [...peopleIn(fake.channelId), selfState()] });
        }
        case 'SELECT_VOICE_CHANNEL': {
          if (args.channel_id === null) {
            fake.channelId = null;
            fake.broadcast('VOICE_CHANNEL_SELECT', { channel_id: null, guild_id: null });
            return reply(msg, null);
          }
          const ch = fake.channels[args.channel_id];
          if (!ch) return error(msg, 4005, `Invalid channel id: ${args.channel_id}`);
          if (fake.channelId && fake.channelId !== args.channel_id && !args.force) return error(msg, 5003, 'Select voice force required');
          // As measured: a join brings no VOICE_CHANNEL_SELECT.
          fake.channelId = args.channel_id;
          return reply(msg, { id: args.channel_id, name: ch.name, type: 2, guild_id: ch.guild_id, voice_states: peopleIn(args.channel_id) });
        }
        case 'SET_USER_VOICE_SETTINGS': {
          const person = Object.values(fake.channels).flatMap((c) => c.people).find((p) => p.id === args.user_id);
          if (!person) return error(msg, 4010, 'Invalid user id');
          if (typeof args.volume === 'number') person.volume = args.volume;
          const channelId = Object.keys(fake.channels).find((id) => fake.channels[id].people.includes(person));
          fake.broadcast('VOICE_STATE_UPDATE', peopleIn(channelId).find((p) => p.user.id === person.id), channelId);
          return reply(msg, { user_id: person.id, pan: { left: 1, right: 1 }, volume: person.volume, mute: false });
        }
        case 'GET_GUILDS':
          return reply(msg, { guilds: fake.guilds });
        case 'GET_CHANNELS':
          return reply(msg, {
            channels: [
              { id: 'c-text', name: 'chat', type: 0 },
              ...Object.entries(fake.channels)
                .filter(([, c]) => c.guild_id === args.guild_id)
                .map(([id, c]) => ({ id, name: c.name, type: 2 })),
            ],
          });
        default:
          return error(msg, 4002, `Invalid command: ${msg.cmd}`);
      }
    };
    conn.socket = socket;
    fake.conns.add(conn);
    socket.on('close', () => fake.conns.delete(conn));
  });
  fake.conns = new Set();
  /** An event to every connection subscribed to it (a voice state event: to that channel's subscribers). */
  fake.broadcast = (evt, data, channelId) => {
    for (const conn of fake.conns) if (conn.subs.has(`${evt}:${channelId ?? ''}`)) conn.dispatch(evt, data);
  };
  /** Something done in Discord itself: mute clicked there. */
  fake.setVoice = (change) => {
    Object.assign(fake.voice, change);
    fake.broadcast('VOICE_SETTINGS_UPDATE', { ...fake.voice });
  };

  await fs.rm(socketPath, { force: true });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  // The token endpoint.
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const fields = Object.fromEntries(new URLSearchParams(body));
      const answer = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if ('client_secret' in fields || req.headers.authorization) {
        fake.secretsSeen++;
        return answer(401, { error: 'invalid_client' });
      }
      if (fields.client_id !== fake.clientId) return answer(401, { error: 'invalid_client' });
      if (req.url === '/oauth2/token/revoke') {
        fake.revoked.push({ hint: fields.token_type_hint, token: fields.token });
        fake.accessTokens.delete(fields.token);
        fake.refreshTokens.delete(fields.token);
        return answer(200, {});
      }
      if (req.url !== '/oauth2/token') return answer(404, {});
      fake.tokenRequests.push({ grant: fields.grant_type, refreshToken: fields.refresh_token, redirect: fields.redirect_uri });
      if (fields.grant_type === 'authorization_code') {
        const code = fake.codes.get(fields.code);
        fake.codes.delete(fields.code);
        const challenge = fields.code_verifier ? createHash('sha256').update(fields.code_verifier).digest('base64url') : null;
        if (!code || code.challenge !== challenge || code.method !== 'S256') return answer(400, { error: 'invalid_grant', error_description: 'Invalid "code_verifier"' });
        if (fields.redirect_uri !== 'http://127.0.0.1') return answer(400, { error: 'invalid_grant', error_description: 'Invalid "redirect_uri" in request.' });
        return answer(200, issue());
      }
      if (fields.grant_type === 'refresh_token') {
        if (!fake.refreshTokens.has(fields.refresh_token)) return answer(400, { error: 'invalid_grant' });
        // Rotates; the old refresh token is spent, and refused if sent again — without ending the link.
        fake.refreshTokens.delete(fields.refresh_token);
        return answer(200, issue());
      }
      answer(400, { error: 'unsupported_grant_type' });
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  fake.apiUrl = `http://127.0.0.1:${httpServer.address().port}`;

  /** Discord quits: every connection closes, and the socket file goes (as the Flatpak's relay's does). */
  fake.quit = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(socketPath, { force: true });
  };
  fake.start = async () => {
    await fs.rm(socketPath, { force: true });
    await new Promise((resolve) => server.listen(socketPath, resolve));
  };
  fake.stop = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    await new Promise((resolve) => httpServer.close(() => resolve()));
    await fs.rm(socketPath, { force: true });
  };
  return fake;
}
