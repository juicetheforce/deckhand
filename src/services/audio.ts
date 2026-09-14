import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';

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

/** Everything the audio key faces display, read in one refresh. */
export interface AudioState {
  sinks: Sink[];
  defaultSink: string;
  /** First channel's volume of the default sink, in percent. */
  defaultSinkVolume: number | null;
  defaultSourceMuted: boolean;
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

/**
 * Match a sink by case-insensitive substring against either its description
 * ("Sennheiser GSP 370") or its node name. Means the config can say
 * "headset" instead of a forty-character alsa_output string that changes
 * when you move the USB port.
 */
export function findSinkIn(sinks: Sink[], match: string): Sink | null {
  const needle = match.toLowerCase();
  return (
    sinks.find((s) => s.description.toLowerCase().includes(needle)) ??
    sinks.find((s) => s.name.toLowerCase().includes(needle)) ??
    null
  );
}

/** Same match as findSinkIn, against a fresh list from pactl. For presses. */
export async function findSink(match: string): Promise<Sink | null> {
  return findSinkIn(await listSinks(), match);
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
    defaultSourceMuted: defaultSourceJson?.mute === true,
  };
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

export async function toggleMicMute(): Promise<void> {
  await pactl(['set-source-mute', '@DEFAULT_SOURCE@', 'toggle']);
  await refreshCache();
}

export async function setMicMute(muted: boolean): Promise<void> {
  await pactl(['set-source-mute', '@DEFAULT_SOURCE@', muted ? '1' : '0']);
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
