import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * PipeWire control through pactl. pactl speaks JSON for its list commands,
 * which beats scraping `wpctl status` output that changes between releases.
 */

export interface Sink {
  index: number;
  name: string;
  description: string;
}

async function pactl(args: string[]): Promise<string> {
  const { stdout } = await run('pactl', args, { timeout: 4000 });
  return stdout;
}

export async function listSinks(): Promise<Sink[]> {
  const raw = await pactl(['-f', 'json', 'list', 'sinks']);
  const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
  return parsed.map((s) => ({
    index: Number(s.index),
    name: String(s.name),
    description: String(s.description ?? s.name),
  }));
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
export async function findSink(match: string): Promise<Sink | null> {
  const needle = match.toLowerCase();
  const sinks = await listSinks();
  return (
    sinks.find((s) => s.description.toLowerCase().includes(needle)) ??
    sinks.find((s) => s.name.toLowerCase().includes(needle)) ??
    null
  );
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
 * Switch the default output. Without moveStreams, anything already playing
 * keeps singing into the old device — which is the usual "I pressed the
 * button and nothing happened" complaint.
 */
export async function setDefaultSink(sinkName: string, moveStreams = true): Promise<void> {
  await pactl(['set-default-sink', sinkName]);
  if (moveStreams) await moveAllStreams(sinkName);
}

export async function getMicMuted(): Promise<boolean> {
  const out = await pactl(['get-source-mute', '@DEFAULT_SOURCE@']);
  return out.toLowerCase().includes('yes');
}

export async function toggleMicMute(): Promise<void> {
  await pactl(['set-source-mute', '@DEFAULT_SOURCE@', 'toggle']);
}

export async function setMicMute(muted: boolean): Promise<void> {
  await pactl(['set-source-mute', '@DEFAULT_SOURCE@', muted ? '1' : '0']);
}

export async function adjustVolume(deltaPercent: number): Promise<void> {
  const arg = deltaPercent >= 0 ? `+${deltaPercent}%` : `${deltaPercent}%`;
  await pactl(['set-sink-volume', '@DEFAULT_SINK@', arg]);
}

export async function getVolume(): Promise<number | null> {
  try {
    const out = await pactl(['get-sink-volume', '@DEFAULT_SINK@']);
    const m = out.match(/(\d+)%/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export async function toggleSinkMute(): Promise<void> {
  await pactl(['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
}

/**
 * Watch for audio changes so buttons showing the current output repaint
 * immediately instead of waiting for the next refresh tick.
 */
export function subscribe(onChange: () => void): () => void {
  let stopped = false;
  let proc: ReturnType<typeof spawn> | null = null;
  let debounce: NodeJS.Timeout | null = null;

  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, 150);
  };

  const start = () => {
    if (stopped) return;
    proc = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes(' sink') || text.includes(' server') || text.includes(' source')) {
        fire();
      }
    });
    proc.on('exit', () => {
      proc = null;
      if (!stopped) setTimeout(start, 2000);
    });
    proc.on('error', (err) => {
      console.error(`[audio] pactl subscribe failed: ${err.message}`);
    });
  };

  start();

  return () => {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    proc?.kill();
  };
}
