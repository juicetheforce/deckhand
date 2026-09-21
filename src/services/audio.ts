import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { PickableDevice } from '../control/protocol.js';

const run = promisify(execFile);

/**
 * PipeWire control through pactl. pactl speaks JSON for its list commands,
 * which beats scraping `wpctl status` output that changes between releases.
 *
 * Two paths, deliberately separate:
 *   - Button presses (set default, toggle mute, ...) call pactl directly and
 *     read fresh data. A press is rare, so a spawn is fine.
 *   - describe() — what a key face shows — reads an in-memory AudioState that
 *     is refreshed only when `pactl subscribe` reports a change. With audio
 *     keys on screen and nothing happening, no pactl process is spawned, and
 *     a render can never block on a hung pactl call.
 */

export interface Sink {
  index: number;
  name: string;
  description: string;
}

/**
 * A sink or source as the control socket needs it to offer a device list
 * (audio.sinks / audio.sources). Everything is from
 * `pactl -f json`; nothing is interpreted beyond what the fields say.
 */
export interface AudioDevice {
  /** node.name, e.g. alsa_output.usb-…-00.analog-stereo. */
  name: string;
  /** As pactl reports it. pactl's JSON gives "(null)" for any non-ASCII description (a known defect). */
  description: string;
  flags: string[];
  /**
   * pactl's monitor_source field, whose meaning depends on the list:
   *   - on a source: the sink it monitors, or "" for a real input;
   *   - on a sink: the name of that sink's own monitor source, never "".
   * Checked against pactl 17.0.
   */
  monitorSource: string;
  /** The active port's availability: "available", "not available", "availability unknown", or null with no ports. */
  portAvailability: string | null;
}

/** Everything the audio key faces display, read in one refresh. */
export interface AudioState {
  sinks: Sink[];
  defaultSink: string;
  /** First channel's volume of the default sink, in percent. */
  defaultSinkVolume: number | null;
  /** Whether the default sink (output) is muted. For audio.mute's face. */
  defaultSinkMuted: boolean;
  defaultSourceMuted: boolean;
  /** Every sink and source, for the control socket's device lists. */
  sinkDevices: AudioDevice[];
  sourceDevices: AudioDevice[];
  defaultSource: string;
}

function parseDevices(json: Array<Record<string, unknown>>): AudioDevice[] {
  return json.map((d) => {
    const ports = Array.isArray(d.ports) ? (d.ports as Array<Record<string, unknown>>) : [];
    const active = ports.find((p) => p.name === d.active_port);
    return {
      name: String(d.name),
      description: String(d.description ?? d.name),
      flags: Array.isArray(d.flags) ? (d.flags as unknown[]).map(String) : [],
      monitorSource: typeof d.monitor_source === 'string' ? d.monitor_source : '',
      portAvailability: active && typeof active.availability === 'string' ? active.availability : null,
    };
  });
}

async function pactl(args: string[]): Promise<string> {
  const { stdout } = await run('pactl', args, { timeout: 4000 });
  return stdout;
}

function parseSinks(raw: string): Sink[] {
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  return parsed.map((s) => ({
    index: Number(s.index),
    name: String(s.name),
    description: String(s.description ?? s.name),
  }));
}

export async function listSinks(): Promise<Sink[]> {
  return parseSinks(await pactl(['-f', 'json', 'list', 'sinks']));
}

export async function getDefaultSink(): Promise<string> {
  return (await pactl(['get-default-sink'])).trim();
}

/** Substrings already reported as matching several sinks, so each is logged once. */
const warnedAmbiguous = new Set<string>();

/**
 * Match a sink by case-insensitive substring against its description, or
 * failing that its node name. **For hand-edited config only**:
 * the editor writes the exact `node` the user picked, found with
 * findSinkByNode() instead.
 *
 * A substring that matches several sinks — a headset's stereo and mono sinks
 * usually share a word — takes the first, as it always has, and says so once
 * per substring. Called from describe() on every refresh,
 * hence once rather than every time.
 */
export function findSinkIn(sinks: Sink[], match: string): Sink | null {
  const needle = match.toLowerCase();
  const byDescription = sinks.filter((s) => s.description.toLowerCase().includes(needle));
  const hits = byDescription.length > 0 ? byDescription : sinks.filter((s) => s.name.toLowerCase().includes(needle));
  if (hits.length > 1 && !warnedAmbiguous.has(match)) {
    warnedAmbiguous.add(match);
    const names = hits.map((s) => `"${s.description}"`).join(', ');
    console.error(`[audio] "${match}" matches ${hits.length} outputs (${names}); using the first. Pick the device in the editor to choose exactly.`);
  }
  return hits[0] ?? null;
}

/** Same match as findSinkIn, against a fresh list from pactl. For presses. */
export async function findSink(match: string): Promise<Sink | null> {
  return findSinkIn(await listSinks(), match);
}

/**
 * The sink whose node name is exactly `node`, from a fresh list — or null if
 * that device is not present. No fallback of any kind: the
 * software applies no logic to what the user picked.
 */
export async function findSinkByNode(node: string): Promise<Sink | null> {
  return (await listSinks()).find((s) => s.name === node) ?? null;
}

/**
 * Every source (input) pactl reports, including monitors — filtering those out
 * is pickableDevices()' job, for the editor's list. For presses, which need a
 * fresh list rather than the cache.
 */
export async function listSources(): Promise<AudioDevice[]> {
  return parseDevices(JSON.parse(await pactl(['-f', 'json', 'list', 'sources'])) as Array<Record<string, unknown>>);
}

/** The default input's node name, as getDefaultSink() is for outputs. */
export async function getDefaultSource(): Promise<string> {
  return (await pactl(['get-default-source'])).trim();
}

/**
 * The source (input) whose node name is exactly `node`, from a fresh list — or
 * null if it is not present. Like findSinkByNode(), no fallback. Monitor
 * sources are not refused here: the editor offers only real inputs, and a
 * hand-written monitor node is the user's call.
 */
export async function findSourceByNode(node: string): Promise<AudioDevice | null> {
  return (await listSources()).find((d) => d.name === node) ?? null;
}

// ---------------------------------------------------------------------------
// Cached state for describe()
// ---------------------------------------------------------------------------

let cache: AudioState | null = null;

/** Percent of the first channel in pactl's JSON volume object, e.g. "18%". */
function firstChannelPercent(volume: unknown): number | null {
  if (!volume || typeof volume !== 'object') return null;
  const first = Object.values(volume as Record<string, { value_percent?: string }>)[0];
  const match = first?.value_percent?.match(/(\d+)%/);
  return match ? Number(match[1]) : null;
}

/** Read the whole picture: three pactl calls, run only when something changed. */
async function readState(): Promise<AudioState> {
  const [infoRaw, sinksRaw, sourcesRaw] = await Promise.all([
    pactl(['-f', 'json', 'info']),
    pactl(['-f', 'json', 'list', 'sinks']),
    pactl(['-f', 'json', 'list', 'sources']),
  ]);

  const info = JSON.parse(infoRaw) as { default_sink_name?: string; default_source_name?: string };
  const sinksJson = JSON.parse(sinksRaw) as Array<Record<string, unknown>>;
  const sourcesJson = JSON.parse(sourcesRaw) as Array<Record<string, unknown>>;

  const defaultSink = String(info.default_sink_name ?? '');
  const defaultSource = String(info.default_source_name ?? '');
  const defaultSinkJson = sinksJson.find((s) => s.name === defaultSink);
  const defaultSourceJson = sourcesJson.find((s) => s.name === defaultSource);

  return {
    sinks: parseSinks(sinksRaw),
    defaultSink,
    defaultSinkVolume: defaultSinkJson ? firstChannelPercent(defaultSinkJson.volume) : null,
    defaultSinkMuted: defaultSinkJson?.mute === true,
    defaultSourceMuted: defaultSourceJson?.mute === true,
    sinkDevices: parseDevices(sinksJson),
    sourceDevices: parseDevices(sourcesJson),
    defaultSource,
  };
}

/**
 * The device list the control socket offers:
 *   - devices flagged NETWORK are left out (not a desktop-audio target);
 *   - monitor sources are left out of the source list (a monitor
 *     of a sink is not an input) — a source is a monitor when its
 *     monitor_source names a sink;
 *   - nothing else is filtered — an unplugged jack is listed as available: "no".
 * The label falls back to the node name where pactl's JSON gave "(null)".
 */
export function pickableDevices(devices: AudioDevice[], kind: 'sink' | 'source'): PickableDevice[] {
  return devices
    .filter((d) => !d.flags.includes('NETWORK'))
    .filter((d) => kind === 'sink' || d.monitorSource === '')
    .map((d) => ({
      node: d.name,
      label: d.description === '(null)' || d.description === '' ? d.name : d.description,
      available: d.portAvailability === 'available' ? 'yes' : d.portAvailability === 'not available' ? 'no' : 'unknown',
    }));
}

/** Re-read audio state into the cache. On failure, the previous state is kept. */
export async function refreshCache(): Promise<void> {
  try {
    cache = await readState();
  } catch (err) {
    console.error(`[audio] could not refresh state: ${(err as Error).message}`);
  }
}

/** The last known audio state, or null before the first refresh completes. */
export function cachedState(): AudioState | null {
  return cache;
}

/** Move every currently-playing stream onto `sinkName`. */
async function moveAllStreams(sinkName: string): Promise<void> {
  const raw = await pactl(['-f', 'json', 'list', 'sink-inputs']);
  const inputs = JSON.parse(raw) as Array<Record<string, unknown>>;
  for (const inp of inputs) {
    try {
      await pactl(['move-sink-input', String(inp.index), sinkName]);
    } catch (err) {
      console.error(`[audio] could not move stream ${inp.index}: ${(err as Error).message}`);
    }
  }
}

/**
 * Point every recording stream at `sourceName`, as moveAllStreams() does for
 * playback. Same shape deliberately: a stream that refuses to move is logged
 * and the rest still move, because one uncooperative application should not
 * leave the others on the old microphone.
 */
async function moveAllSourceOutputs(sourceName: string): Promise<void> {
  const raw = await pactl(['-f', 'json', 'list', 'source-outputs']);
  const outputs = JSON.parse(raw) as Array<Record<string, unknown>>;
  for (const out of outputs) {
    try {
      await pactl(['move-source-output', String(out.index), sourceName]);
    } catch (err) {
      console.error(`[audio] could not move recording stream ${out.index}: ${(err as Error).message}`);
    }
  }
}

// Every change made by a press re-reads the cache before returning, so the
// key that was pressed repaints with the new state straight away rather than
// waiting for the subscribe event to arrive.

/**
 * Switch the default output. Without moveStreams, anything already playing
 * keeps singing into the old device — which is the usual "I pressed the
 * button and nothing happened" complaint.
 */
export async function setDefaultSink(sinkName: string, moveStreams = true): Promise<void> {
  await pactl(['set-default-sink', sinkName]);
  if (moveStreams) await moveAllStreams(sinkName);
  await refreshCache();
}

/**
 * Switch the default input, and drag recording streams along — the mirror of
 * setDefaultSink(), including the default.
 *
 * Without moveStreams the key face changes to the new microphone while the
 * application carries on reading the old one: the input version of "I pressed
 * the button and nothing happened". Tested on
 * hardware: Discord followed the switch.
 */
export async function setDefaultSource(sourceName: string, moveStreams = true): Promise<void> {
  await pactl(['set-default-source', sourceName]);
  if (moveStreams) await moveAllSourceOutputs(sourceName);
  await refreshCache();
}

export async function toggleMicMute(): Promise<void> {
  await pactl(['set-source-mute', '@DEFAULT_SOURCE@', 'toggle']);
  await refreshCache();
}

export async function adjustVolume(deltaPercent: number): Promise<void> {
  const arg = deltaPercent >= 0 ? `+${deltaPercent}%` : `${deltaPercent}%`;
  await pactl(['set-sink-volume', '@DEFAULT_SINK@', arg]);
  await refreshCache();
}

export async function toggleSinkMute(): Promise<void> {
  await pactl(['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
  await refreshCache();
}

/**
 * Only these events change what the cache holds: a sink or source itself
 * (volume, mute, added, removed), a card (profile changes add and remove
 * sinks), and the server (the default sink or source changed).
 *
 * Deliberately NOT matched:
 *   - "client" events. Every pactl call — including the cache's own refresh —
 *     connects as a client and produces 'new'/'remove' on client. Matching
 *     them would make each refresh trigger the next, forever.
 *   - "sink-input" / "source-output" events: individual streams starting,
 *     stopping or changing volume, which happen constantly during playback
 *     and change nothing the key faces show.
 */
const STATE_CHANGE_EVENT = /^Event '\w+' on (sink|source|card|server) #/;

/**
 * Keep the cache current: read it once at start (and after any restart of
 * `pactl subscribe`), then again after each relevant event. `onChange` runs
 * only once the fresh state is in the cache, so the repaint it triggers
 * shows the new state.
 */
export function subscribe(onChange: () => void): () => void {
  let stopped = false;
  let proc: ReturnType<typeof spawn> | null = null;
  let debounce: NodeJS.Timeout | null = null;

  const refreshThenNotify = () => {
    void refreshCache().then(() => {
      if (!stopped) onChange();
    });
  };

  // A burst of events (a device plugged in produces several) becomes one
  // refresh, 150 ms after the last of them.
  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(refreshThenNotify, 150);
  };

  const start = () => {
    if (stopped) return;
    proc = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (proc.stdout) {
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        if (STATE_CHANGE_EVENT.test(line)) fire();
      });
    }
    proc.on('exit', () => {
      proc = null;
      if (!stopped) setTimeout(start, 2000);
    });
    proc.on('error', (err) => {
      console.error(`[audio] pactl subscribe failed: ${err.message}`);
    });
    // Anything that changed while no subscriber was listening is picked up here.
    refreshThenNotify();
  };

  start();

  return () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    proc?.kill();
  };
}
