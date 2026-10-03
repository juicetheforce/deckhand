/**
 * A fake OBS Studio for the tests: an obs-websocket v5 server on a port of
 * its own, speaking enough of the protocol for src/services/obs-client.ts and
 * src/services/obs.ts — Hello with an auth challenge, Identify checked against
 * the password (closing 4009 when wrong), requests answered from a small model
 * of OBS's outputs, and the events OBS sends when they change.
 *
 * Node has a WebSocket client but no server, so the server side is written
 * by hand: the HTTP upgrade here, the frames in ws-frames.mjs (shared with
 * fake-vts.mjs). No dependency.
 *
 *   const obs = await startFakeObs({ password: 'secret' });
 *   obs.port; obs.requests; obs.connections; obs.identified;
 *   obs.setStream(true);   // as if OBS went live by itself: sends the events
 *   obs.setProgram('BRB'); obs.setMuted('Mic/Aux', true); obs.setItemEnabled('Gameplay', 'Webcam', false);
 *   obs.renameInput('Mic/Aux', 'Mic');
 *   await obs.stop();      // as if OBS quit: closes every client, frees the port
 *
 * The protocol: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { closeSocket, readFrame, writeFrame } from './ws-frames.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Event categories (Identify's eventSubscriptions): an event goes only to clients that asked for its own. */
const SCENES = 1 << 2;
const INPUTS = 1 << 3;
const OUTPUTS = 1 << 6;
const SCENE_ITEMS = 1 << 7;
/** obs-websocket's RequestStatus::ResourceNotFound. */
const RESOURCE_NOT_FOUND = 600;
/** libobs' OBS_SOURCE_VIDEO and OBS_SOURCE_AUDIO output flags. */
const VIDEO = 1 << 0;
const AUDIO = 1 << 1;
const sha256base64 = (text) => createHash('sha256').update(text).digest('base64');

export async function startFakeObs({ password = null, port = 0 } = {}) {
  const sockets = new Set();
  const obs = {
    port: 0,
    password,
    /** Every request received, in order: { type, data }. */
    requests: [],
    /** Connections accepted, and connections that got as far as Identified. */
    connections: 0,
    identified: 0,
    /** The last Identify's eventSubscriptions. */
    eventSubscriptions: null,
    streaming: false,
    recording: false,
    paused: false,
    /**
     * Whether OBS can pause the recording. A real OBS cannot when the
     * recording shares the stream's encoder (Simple output, Recording Quality
     * "Same as stream" — the default), and then ignores a pause in silence.
     */
    pausable: true,
    /**
     * How the next start goes, for the stream and the recording: 'ok'; 'silent',
     * as a real OBS fails a start it cannot make (no stream service set up, an
     * encoder that will not start) — STARTING, then nothing at all, since
     * OBSBasic::StartStreaming and StartRecording return after their error
     * dialog without a STOPPED (OBS 32.1 source, read 2026-10-01); or
     * 'stopped', as a connection that fails afterwards — STARTING, then
     * STOPPED (OBSBasic::StreamingStop).
     */
    startOutcome: { stream: 'ok', record: 'ok' },
    /** Scenes as OBS's window lists them, top first; the program scene. */
    scenes: ['Starting', 'Gameplay', 'BRB'],
    program: 'Starting',
    /** Inputs: a mic and desktop audio (audio), a webcam (video only). */
    inputs: [
      { name: 'Mic/Aux', caps: AUDIO, muted: false },
      { name: 'Desktop Audio', caps: AUDIO, muted: false },
      { name: 'Webcam', caps: VIDEO, muted: false },
    ],
    /** Each scene's items, top first as OBS's Sources list shows them. */
    items: {
      Starting: [{ id: 1, source: 'Countdown', enabled: true }],
      Gameplay: [
        { id: 1, source: 'Webcam', enabled: true },
        { id: 2, source: 'Game capture', enabled: true },
      ],
      BRB: [],
    },
    setProgram(name) {
      obs.program = name;
      broadcast('CurrentProgramSceneChanged', { sceneName: name, sceneUuid: `uuid-${name}` }, SCENES);
    },
    setMuted(name, muted) {
      obs.inputs.find((i) => i.name === name).muted = muted;
      broadcast('InputMuteStateChanged', { inputName: name, inputUuid: `uuid-${name}`, inputMuted: muted }, INPUTS);
    },
    setItemEnabled(scene, source, enabled) {
      const item = obs.items[scene].find((i) => i.source === source);
      item.enabled = enabled;
      broadcast('SceneItemEnableStateChanged', { sceneName: scene, sceneUuid: `uuid-${scene}`, sceneItemId: item.id, sceneItemEnabled: enabled }, SCENE_ITEMS);
    },
    renameInput(from, to) {
      obs.inputs.find((i) => i.name === from).name = to;
      for (const items of Object.values(obs.items)) for (const item of items) if (item.source === from) item.source = to;
      broadcast('InputNameChanged', { inputUuid: `uuid-${from}`, oldInputName: from, inputName: to }, INPUTS);
    },
    setStream(on) {
      obs.streaming = on;
      broadcast('StreamStateChanged', { outputActive: on, outputState: on ? 'OBS_WEBSOCKET_OUTPUT_STARTED' : 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    },
    /** Send any event to every identified client that asked for its category (Outputs unless given), as OBS would. */
    event(type, data, intent = OUTPUTS) {
      broadcast(type, data, intent);
    },
    /** Clients connected right now. */
    get open() {
      return [...sockets].filter((s) => s.identifiedAt !== undefined).length;
    },
    stop,
  };

  const server = http.createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (!key || !protocols.includes('obswebsocket.json')) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${createHash('sha1').update(key + GUID).digest('base64')}\r\n` +
        'Sec-WebSocket-Protocol: obswebsocket.json\r\n\r\n',
    );
    obs.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const challenge = randomBytes(16).toString('base64');
    const salt = randomBytes(16).toString('base64');
    socket.auth = { challenge, salt };
    send(socket, 0, {
      obsStudioVersion: '32.1.1-fake',
      obsWebSocketVersion: '5.7.3',
      rpcVersion: 1,
      ...(obs.password ? { authentication: { challenge, salt } } : {}),
    });
    let buffer = Buffer.alloc(0);
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
        if (frame.opcode === 0x1) onMessage(socket, JSON.parse(frame.payload.toString('utf8')));
      }
    });
  });

  function onMessage(socket, message) {
    const d = message.d ?? {};
    if (message.op === 1) {
      if (obs.password) {
        const expected = sha256base64(sha256base64(obs.password + socket.auth.salt) + socket.auth.challenge);
        if (d.authentication !== expected) {
          closeSocket(socket, 4009, 'Authentication failed.');
          return;
        }
      }
      obs.eventSubscriptions = d.eventSubscriptions;
      obs.identified++;
      socket.identifiedAt = Date.now();
      send(socket, 2, { negotiatedRpcVersion: 1 });
      return;
    }
    if (message.op !== 6 || socket.identifiedAt === undefined) return;
    obs.requests.push({ type: d.requestType, data: d.requestData });
    const reply = (ok, responseData, comment, code = 501) =>
      send(socket, 7, {
        requestType: d.requestType,
        requestId: d.requestId,
        requestStatus: ok ? { result: true, code: 100 } : { result: false, code, comment },
        ...(responseData ? { responseData } : {}),
      });
    const r = d.requestData ?? {};
    const notFound = (what) => reply(false, null, `No source was found by the name of \`${what}\`.`, RESOURCE_NOT_FOUND);
    const input = obs.inputs.find((i) => i.name === r.inputName);
    const sceneItems = typeof r.sceneName === 'string' ? obs.items[r.sceneName] : undefined;
    switch (d.requestType) {
      case 'GetStreamStatus':
        return reply(true, { outputActive: obs.streaming, outputReconnecting: false, outputDuration: 0 });
      case 'GetRecordStatus':
        return reply(true, { outputActive: obs.recording, outputPaused: obs.paused });
      case 'StartStream':
        if (obs.streaming) return reply(false, null, 'The stream output is already running.');
        reply(true);
        return start('StreamStateChanged', obs.startOutcome.stream, () => (obs.streaming = true));
      case 'StopStream':
        if (!obs.streaming) return reply(false, null, 'The stream output is not running.');
        reply(true);
        broadcast('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' });
        obs.streaming = false;
        return broadcast('StreamStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
      // The four states in the order a real OBS sends them, outputActive as it
      // reports it: STARTING false, STARTED true, STOPPING false, STOPPED false
      // (OBS 32.1.1, seen 2026-10-01; code-state, OBS session 1). Streaming is
      // given the same shape, unobserved.
      case 'StartRecord':
        if (obs.recording) return reply(false, null, 'The record output is already running.');
        reply(true);
        return start('RecordStateChanged', obs.startOutcome.record, () => (obs.recording = true));
      case 'StopRecord':
        if (!obs.recording) return reply(false, null, 'The record output is not running.');
        obs.recording = false;
        obs.paused = false;
        reply(true, { outputPath: '/tmp/fake.mkv' });
        broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' });
        return broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
      case 'ToggleRecord':
        obs.recording = !obs.recording;
        if (!obs.recording) obs.paused = false;
        reply(true, { outputActive: obs.recording });
        if (obs.recording) {
          broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
          return broadcast('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
        }
        broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' });
        return broadcast('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
      // As obs-websocket does (RequestHandler_Record.cpp): success, always,
      // whatever OBS then does — nothing at all when nothing is recording or
      // the recording cannot be paused (OBS's PauseRecording()).
      case 'ToggleRecordPause':
        reply(true, { outputPaused: !obs.paused });
        if (!obs.recording || !obs.pausable) return undefined;
        obs.paused = !obs.paused;
        return broadcast('RecordStateChanged', { outputActive: true, outputState: obs.paused ? 'OBS_WEBSOCKET_OUTPUT_PAUSED' : 'OBS_WEBSOCKET_OUTPUT_RESUMED' });
      // Scenes, inputs and scene items: the fields obs-websocket 5.7.3 sends
      // (src/utils/Obs_ArrayHelper.cpp), including sceneIndex counting from
      // the bottom of OBS's list and both names GetCurrentProgramScene gives.
      case 'GetCurrentProgramScene':
        return reply(true, { sceneName: obs.program, currentProgramSceneName: obs.program });
      case 'SetCurrentProgramScene':
        if (!obs.scenes.includes(r.sceneName)) return notFound(r.sceneName);
        reply(true);
        return obs.setProgram(r.sceneName);
      case 'GetSceneList':
        return reply(true, {
          currentProgramSceneName: obs.program,
          scenes: obs.scenes.map((name, i) => ({ sceneName: name, sceneUuid: `uuid-${name}`, sceneIndex: obs.scenes.length - i - 1 })).reverse(),
        });
      case 'GetInputList':
        return reply(true, { inputs: obs.inputs.map((i) => ({ inputName: i.name, inputUuid: `uuid-${i.name}`, inputKind: 'fake', unversionedInputKind: 'fake', inputKindCaps: i.caps })) });
      case 'GetInputMute':
        if (!input) return notFound(r.inputName);
        return reply(true, { inputMuted: input.muted });
      case 'ToggleInputMute':
        if (!input) return notFound(r.inputName);
        reply(true, { inputMuted: !input.muted });
        return obs.setMuted(input.name, !input.muted);
      case 'GetSceneItemList':
        if (!sceneItems) return notFound(r.sceneName);
        return reply(true, {
          sceneItems: sceneItems.map((it, i) => ({ sceneItemId: it.id, sceneItemIndex: sceneItems.length - i - 1, sourceName: it.source, sceneItemEnabled: it.enabled })).reverse(),
        });
      case 'GetSceneItemId': {
        const item = sceneItems?.find((it) => it.source === r.sourceName);
        if (!item) return notFound(r.sourceName);
        return reply(true, { sceneItemId: item.id });
      }
      case 'GetSceneItemEnabled':
      case 'SetSceneItemEnabled': {
        const item = sceneItems?.find((it) => it.id === r.sceneItemId);
        if (!item) return notFound(r.sceneItemId);
        if (d.requestType === 'GetSceneItemEnabled') return reply(true, { sceneItemEnabled: item.enabled });
        reply(true);
        return obs.setItemEnabled(r.sceneName, item.source, r.sceneItemEnabled === true);
      }
      default:
        return reply(false, null, `fake OBS does not know ${d.requestType}`);
    }
  }

  /** Events go to identified clients that asked for their category (Outputs unless given), as OBS's do. */
  /** A start as obs.startOutcome says: STARTING, then STARTED, nothing, or STOPPED. */
  function start(eventType, outcome, began) {
    broadcast(eventType, { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
    if (outcome === 'silent') return undefined;
    if (outcome === 'stopped') return broadcast(eventType, { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
    began();
    return broadcast(eventType, { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  }

  function broadcast(eventType, eventData, intent = OUTPUTS) {
    for (const socket of sockets) {
      if (socket.identifiedAt === undefined || !(obs.eventSubscriptions & intent)) continue;
      send(socket, 5, { eventType, eventIntent: intent, eventData });
    }
  }

  async function stop() {
    for (const socket of sockets) closeSocket(socket, 1001);
    await new Promise((resolve) => server.close(resolve));
  }

  // A port already taken rejects (EADDRINUSE) rather than leaving an unhandled error.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  obs.port = server.address().port;
  return obs;
}

function send(socket, op, d) {
  writeFrame(socket, 0x1, Buffer.from(JSON.stringify({ op, d })));
}
