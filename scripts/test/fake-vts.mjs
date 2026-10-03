/**
 * A fake VTube Studio for the tests: its public API on a port of its own,
 * modelled on what a real VTS 1.35.10 did under Proton (docs/code-state.md,
 * "VTube Studio — session 1") rather than on its README where the two differ:
 *
 *   - replies over 1016 bytes split into fragments, as websocket-sharp does;
 *   - a request needing authentication on a session that has none: error 8;
 *   - a token request shows a "window" that the test answers (allow, deny),
 *     or answers itself; a second request while one shows: error 51 — and
 *     **a request whose connection has gone still shows, and still blocks**;
 *   - revoking leaves connections open but unauthenticated (error 8 after);
 *   - a hotkey's HotkeyTriggeredEvent arrives before its response;
 *   - a model load answers at once and completes later ("unloaded" for the
 *     old model, then "loaded"); a second within 2 s: error 153;
 *   - ExpressionToggledEvent is unknown on the stable branch: error 950;
 *   - expression state is the loaded model's only, whatever model is named;
 *     a model keeps its expressions across a switch; a direct activation
 *     fires no HotkeyTriggeredEvent (VTS sessions 1 and 2);
 *   - the API turned off closes every connection and refuses new ones; the
 *     broadcast, sent only when a test asks, says active false.
 *
 *   const vts = await startFakeVts({ approval: 'allow' });   // or 'deny', 'hold'
 *   vts.port; vts.requests; vts.tokenRequests; vts.triggered; vts.extensionsOffered;
 *   vts.answer('allow');           // answer the window showing, as a person would
 *   vts.revoke();                  // every token issued so far stops working
 *   vts.loadModel('m2');           // as if the person loaded another model in VTS
 *   vts.loadDelayMs = 600;         // how long a load takes; vts.loadCompletes = false: it never does
 *   vts.setExpression('EyesLove.exp3.json', true);   // as if turned on in VTS's own window
 *   await vts.apiOff(); await vts.apiOn();
 *   await vts.broadcast(port, { active: true });   // one UDP packet to 127.0.0.1:port
 *   await vts.stop();
 */
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import { closeSocket, readFrame, writeFragmented, writeFrame } from './ws-frames.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KNOWN_EVENTS = new Set(['TestEvent', 'ModelLoadedEvent', 'TrackingStatusChangedEvent', 'BackgroundChangedEvent', 'ModelConfigChangedEvent', 'ModelMovedEvent', 'HotkeyTriggeredEvent', 'ModelAnimationEvent', 'ItemEvent']);
const MODEL_LOAD_COOLDOWN_MS = 2000;

export async function startFakeVts({ approval = 'allow', port = 0, branch = 'stable', loadDelayMs = 50 } = {}) {
  const sockets = new Set();
  /** Tokens issued: token → { name, developer, revoked }. */
  const tokens = new Map();
  /** The token request VTS's window shows, if any: { socket, requestID, data }. */
  let showing = null;
  let lastModelLoad = 0;

  const vts = {
    port: 0,
    version: '1.35.10',
    branch,
    /** How a token request is answered: 'allow' and 'deny' at once; 'hold' until answer(). */
    approval,
    /** Every request received, in order: { type, data }. */
    requests: [],
    /** Every token request: { pluginName, pluginDeveloper, iconBytes }. */
    tokenRequests: [],
    /** Hotkey IDs triggered, in order. */
    triggered: [],
    /** Each connection's Sec-WebSocket-Extensions offer ('' for none). */
    extensionsOffered: [],
    connections: 0,
    /** How long a model load takes after its answer (a real one took ~1.1–1.7 s). */
    loadDelayMs,
    /** False: a load unloads the old model and never says the new one has loaded. */
    loadCompletes: true,
    models: [
      { id: 'm1', name: 'Akari' },
      { id: 'm2', name: 'Hiyori' },
    ],
    loaded: 'm1',
    hotkeys: {
      m1: [
        { hotkeyID: 'hk-heart', name: 'Heart Eyes', type: 'ToggleExpression', file: 'EyesLove.exp3.json' },
        { hotkeyID: 'hk-shake', name: 'Anim Shake', type: 'TriggerAnimation', file: 'Love.motion3.json' },
        // A hotkey with no name, as VTS allows.
        { hotkeyID: 'hk-unnamed', name: '', type: 'TriggerAnimation', file: 'Shock.motion3.json' },
      ],
      m2: [{ hotkeyID: 'hk-wave', name: 'Wave', type: 'TriggerAnimation', file: 'Wave.motion3.json' }],
    },
    /** Each model's expressions, by file: on or off. Kept across loads, as VTS keeps them. */
    expressions: {
      m1: { 'EyesCry.exp3.json': false, 'EyesLove.exp3.json': false },
      m2: {},
    },
    /** As if an expression of the loaded model were turned on or off in VTS's own window: an event only on the beta branch. */
    setExpression(file, active) {
      setExpressionOf(vts.loaded, file, active);
    },
    /** Answer the window showing, as the person would. With no connection left to tell, it just closes. */
    answer(how) {
      if (!showing) throw new Error('fake VTS: no token request is showing');
      const { socket, requestID, data } = showing;
      showing = null;
      if (how === 'allow') {
        const token = randomBytes(32).toString('hex');
        tokens.set(token, { name: data.pluginName, developer: data.pluginDeveloper, revoked: false });
        send(socket, requestID, 'AuthenticationTokenResponse', { authenticationToken: token });
      } else {
        send(socket, requestID, 'APIError', { errorID: 50, message: 'User denied authentication request for your plugin.' });
      }
    },
    get showing() {
      return showing !== null;
    },
    /** Every token issued stops working; open sessions become unauthenticated and stay open, as VTS's do. */
    revoke() {
      for (const t of tokens.values()) t.revoked = true;
      for (const socket of sockets) socket.authenticated = false;
    },
    /** As if the person loaded another model in VTS's window. */
    loadModel(id) {
      const old = vts.loaded;
      if (old) emit('ModelLoadedEvent', { modelLoaded: false, modelName: nameOf(old), modelID: old });
      vts.loaded = null;
      if (!vts.loadCompletes) return;
      setTimeout(() => {
        vts.loaded = id;
        emit('ModelLoadedEvent', { modelLoaded: true, modelName: nameOf(id), modelID: id });
      }, vts.loadDelayMs);
    },
    /** Connections open right now. */
    get open() {
      return sockets.size;
    },
    /** The API turned off in VTS's settings: every connection closed, new ones refused. */
    async apiOff() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
    /** And on again, on the same port. */
    async apiOn() {
      await listen(vts.port);
    },
    /** One broadcast, as VTS sends every few seconds, to 127.0.0.1:port. */
    async broadcast(toPort, { active = true, apiPort = vts.port } = {}) {
      const packet = JSON.stringify({
        apiName: 'VTubeStudioPublicAPI',
        apiVersion: '1.0',
        timestamp: Date.now(),
        messageType: 'VTubeStudioAPIStateBroadcast',
        requestID: 'VTubeStudioAPIStateBroadcast',
        data: { active, port: apiPort, trackingPort: -1, instanceID: 'fake', windowTitle: 'VTube Studio' },
      });
      const udp = dgram.createSocket('udp4');
      await new Promise((resolve) => udp.send(packet, toPort, '127.0.0.1', resolve));
      udp.close();
    },
    stop,
  };

  const nameOf = (id) => vts.models.find((m) => m.id === id)?.name ?? id;

  function setExpressionOf(model, file, active) {
    vts.expressions[model][file] = active;
    if (vts.branch === 'beta') {
      emit('ExpressionToggledEvent', { modelID: model, modelName: nameOf(model), isLive2DItem: false, itemInstanceID: '', justLoaded: false, expressionFile: file, expressionName: file.replace(/\.exp3\.json$/, ''), active });
    }
  }
  const expressionList = (model) =>
    Object.entries(vts.expressions[model] ?? {}).map(([file, active]) => ({
      name: file.replace(/\.exp3\.json$/, ''),
      file,
      active,
      deactivateWhenKeyIsLetGo: false,
      autoDeactivateAfterSeconds: false,
      secondsRemaining: 0,
      usedInHotkeys: (vts.hotkeys[model] ?? []).filter((h) => h.type === 'ToggleExpression' && h.file === file).map((h) => ({ name: h.name, id: h.hotkeyID })),
      parameters: [],
    }));

  const server = http.createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    vts.extensionsOffered.push(String(req.headers['sec-websocket-extensions'] ?? ''));
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nServer: websocket-sharp/1.0\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n\r\n`,
    );
    vts.connections++;
    socket.authenticated = false;
    socket.subscribed = new Set();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = Buffer.alloc(0);
    let parts = [];
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 0x8) {
          closeSocket(socket, 1000);
          return;
        }
        if (frame.opcode === 0x9) writeFrame(socket, 0xa, frame.payload);
        if (frame.opcode !== 0x1 && frame.opcode !== 0x0) continue;
        parts.push(frame.payload);
        if (!frame.fin) continue;
        const text = Buffer.concat(parts).toString();
        parts = [];
        handle(socket, JSON.parse(text));
      }
    });
  });

  function handle(socket, message) {
    const { requestID, messageType: type, data = {} } = message;
    vts.requests.push({ type, data });
    const reply = (responseType, payload) => send(socket, requestID, responseType, payload);
    const error = (errorID, text) => reply('APIError', { errorID, message: text });
    if (type === 'APIStateRequest') return reply('APIStateResponse', { active: true, vTubeStudioVersion: vts.version, currentSessionAuthenticated: socket.authenticated });
    if (type === 'AuthenticationTokenRequest') {
      vts.tokenRequests.push({ pluginName: data.pluginName, pluginDeveloper: data.pluginDeveloper, iconBytes: data.pluginIcon ? Buffer.from(data.pluginIcon, 'base64').length : 0 });
      if (showing) return error(51, 'Cannot start authentication process because authentication is currently ongoing.');
      showing = { socket, requestID, data };
      if (vts.approval !== 'hold') vts.answer(vts.approval);
      return undefined;
    }
    if (type === 'AuthenticationRequest') {
      const issued = tokens.get(data.authenticationToken);
      const ok = issued !== undefined && !issued.revoked && issued.name === data.pluginName && issued.developer === data.pluginDeveloper;
      socket.authenticated = ok;
      return reply('AuthenticationResponse', {
        authenticated: ok,
        reason: ok ? 'Token valid. The plugin is authenticated for the duration of this session.' : 'Authentication request failed because token is invalid or has been revoked by the user.',
      });
    }
    if (!socket.authenticated) {
      return error(8, 'Current session is not authenticated. The only requests you can send without authenticating are: [APIStateRequest, AuthenticationTokenRequest, AuthenticationRequest]');
    }
    switch (type) {
      case 'CurrentModelRequest':
        return reply('CurrentModelResponse', { modelLoaded: vts.loaded !== null, modelName: vts.loaded ? nameOf(vts.loaded).toLowerCase() : '', modelID: vts.loaded ?? '' });
      case 'AvailableModelsRequest':
        return reply('AvailableModelsResponse', {
          numberOfModels: vts.models.length,
          availableModels: vts.models.map((m) => ({ modelLoaded: m.id === vts.loaded, modelName: m.name, modelID: m.id, vtsModelName: `${m.name.toLowerCase()}.vtube.json`, vtsModelIconName: 'icon.jpg' })),
        });
      case 'HotkeysInCurrentModelRequest': {
        const id = data.modelID || vts.loaded;
        // What a real VTS answers for an ID it does not have is untested: the fake says 152.
        if (!vts.hotkeys[id]) return error(152, 'No model with that ID found.');
        return reply('HotkeysInCurrentModelResponse', {
          modelLoaded: id === vts.loaded,
          modelName: nameOf(id),
          modelID: id,
          availableHotkeys: vts.hotkeys[id].map((h, i) => ({ ...h, description: '', keyCombination: [], onScreenButtonID: i + 1 })),
        });
      }
      case 'HotkeyTriggerRequest': {
        const hotkey = (vts.hotkeys[vts.loaded] ?? []).find((h) => h.hotkeyID === data.hotkeyID);
        if (!hotkey) return error(202, 'Hotkey execution failed because hotkey ID or name was not found in model.');
        vts.triggered.push(hotkey.hotkeyID);
        if (hotkey.type === 'ToggleExpression') setExpressionOf(vts.loaded, hotkey.file, !vts.expressions[vts.loaded][hotkey.file]);
        if (hotkey.type === 'RemoveAllExpressions') for (const file of Object.keys(vts.expressions[vts.loaded])) if (vts.expressions[vts.loaded][file]) setExpressionOf(vts.loaded, file, false);
        // The event first, then the answer, as VTS 1.35.10 sends them.
        emit('HotkeyTriggeredEvent', { hotkeyID: hotkey.hotkeyID, hotkeyName: hotkey.name, hotkeyAction: hotkey.type, hotkeyFile: hotkey.file, hotkeyTriggeredByAPI: true, modelID: vts.loaded, modelName: nameOf(vts.loaded), isLive2DItem: false });
        return reply('HotkeyTriggerResponse', { hotkeyID: hotkey.hotkeyID });
      }
      case 'ModelLoadRequest': {
        if (Date.now() - lastModelLoad < MODEL_LOAD_COOLDOWN_MS) return error(153, 'The model load cooldown is still active. You can only send this request once every 2 seconds.');
        if (!vts.models.some((m) => m.id === data.modelID)) return error(152, 'No model with that ID found.');
        lastModelLoad = Date.now();
        reply('ModelLoadResponse', { modelID: data.modelID });
        return vts.loadModel(data.modelID);
      }
      // The loaded model's, whatever model is named: VTS 1.35.10 ignores a modelID here (VTS session 2).
      case 'ExpressionStateRequest': {
        if (!vts.loaded) return reply('ExpressionStateResponse', { modelLoaded: false, modelName: '', modelID: '', expressions: [] });
        let list = expressionList(vts.loaded);
        if (data.expressionFile) {
          if (!String(data.expressionFile).endsWith('.exp3.json')) return error(600, 'Invalid expression file name.');
          list = list.filter((e) => e.file === data.expressionFile);
          if (list.length === 0) return error(601, 'Expression file not found in current model.');
        }
        return reply('ExpressionStateResponse', { modelLoaded: true, modelName: nameOf(vts.loaded).toLowerCase(), modelID: vts.loaded, expressions: list });
      }
      case 'ExpressionActivationRequest': {
        if (!vts.loaded) return error(652, 'No model loaded.');
        if (!String(data.expressionFile).endsWith('.exp3.json')) return error(650, 'Invalid expression file name.');
        if (!(data.expressionFile in vts.expressions[vts.loaded])) return error(651, 'Expression file not found in current model.');
        setExpressionOf(vts.loaded, data.expressionFile, data.active === true);
        return reply('ExpressionActivationResponse', {});
      }
      case 'EventSubscriptionRequest': {
        const known = KNOWN_EVENTS.has(data.eventName) || (vts.branch === 'beta' && data.eventName === 'ExpressionToggledEvent');
        if (!known) return error(950, `Unknown API event type: ${data.eventName}`);
        if (data.subscribe) socket.subscribed.add(data.eventName);
        else socket.subscribed.delete(data.eventName);
        return reply('EventSubscriptionResponse', { subscribedEventCount: socket.subscribed.size, subscribedEvents: [...socket.subscribed] });
      }
      default:
        return error(1, `fake VTS does not know ${type}`);
    }
  }

  /** An event to every authenticated connection subscribed to it. */
  function emit(eventType, data) {
    for (const socket of sockets) {
      if (socket.authenticated && socket.subscribed.has(eventType)) send(socket, randomBytes(16).toString('hex'), eventType, data);
    }
  }

  async function stop() {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  // A port already taken rejects (EADDRINUSE) rather than leaving an unhandled error.
  function listen(at) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(at, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  }
  await listen(port);
  vts.port = server.address().port;
  return vts;
}

function send(socket, requestID, messageType, data) {
  writeFragmented(socket, JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', timestamp: Date.now(), messageType, requestID, data }));
}
