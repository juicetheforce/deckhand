import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The soundboard's player: each sound a key plays is a `pw-play` process —
 * `paplay` where pw-play is missing, which comes in the same package as the
 * `pactl` the audio keys already need (pulseaudio-utils on Fedora, Debian and
 * Ubuntu; libpulse on Arch). Both decode WAV, MP3, Ogg and FLAC through
 * libsndfile, and both take an output by its node name, the one the audio
 * device lists give.
 *
 * **What a key shows comes from its player starting and ending**, never from a
 * clock: a start and every exit call the listeners, which mark the sound keys
 * stale (src/index.ts), and the deck draws them on its next tick. A loop is a
 * player started again when the last one ends — again an event, not a timer.
 *
 * **The player is the daemon's own child**, as `pactl` is — the one thing a
 * deck starts that is, on purpose (ARCHITECTURE, "Nothing launched from a deck
 * is the daemon's child"). Its life *is* the key's state, and a daemon that
 * stops should stop its sounds: an update or a logout ends them, as it ends
 * everything else the daemon holds.
 */

/** How a press of a Play sound key behaves, as Elgato's Soundboard names them. */
export type PlayMode = 'playStop' | 'playRestart' | 'playOverlap' | 'loopStop' | 'hold';
export const PLAY_MODES: readonly PlayMode[] = ['playStop', 'playRestart', 'playOverlap', 'loopStop', 'hold'];

/** What one sound is: the file, where it plays and how loud. */
export interface SoundSpec {
  /** An absolute path, `~/` already expanded. */
  file: string;
  /** An output's node name; null plays on the system's default output. */
  node: string | null;
  /** 0–100, percent of the file's own level. */
  volume: number;
}

/**
 * A player that ends sooner than this after it started is never started again
 * by a loop, so a file that plays nothing cannot respawn in a loop. Two
 * timestamps, not a timer.
 */
const MIN_LOOP_MS = 250;

/**
 * How long a press waits to see whether its player failed at once — a file it
 * cannot decode, a format the machine's libsndfile does not read — so the key
 * is marked instead of doing nothing. A one-shot deadline, as Stream's start
 * confirmation is; measured, a bad file ends pw-play in ~14 ms.
 */
export const START_CONFIRM_MS = Number(process.env.DECKHAND_SOUND_CONFIRM_MS) || 250;

interface Playing {
  players: Set<ChildProcess>;
  /** Started again when it ends, until stopped. */
  looping: boolean;
}

/** What is playing, by sound id (soundId): two keys with the same sound are the same sound. */
const playing = new Map<string, Playing>();
/**
 * Players stopped by Deckhand: pw-play ends with exit code 1 when it is sent
 * SIGTERM, and paplay with 0 (measured), so neither the code nor the signal
 * tells a stopped player from a failed one.
 */
const stoppedByUs = new WeakSet<ChildProcess>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Called whenever a sound starts or ends. Returns the unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The identity of a key's sound, so a press finds the players an earlier press started. */
export function soundId(spec: SoundSpec, mode: PlayMode): string {
  return JSON.stringify([spec.file, spec.node ?? '', spec.volume, mode]);
}

export function isPlaying(id: string): boolean {
  return (playing.get(id)?.players.size ?? 0) > 0;
}

/** How many players of this sound are running: more than one only for Play/Overlap. */
export function playerCount(id: string): number {
  return playing.get(id)?.players.size ?? 0;
}

export function isLooping(id: string): boolean {
  return isPlaying(id) && playing.get(id)?.looping === true;
}

/** Whether anything Deckhand started is playing. */
export function anyPlaying(): boolean {
  return [...playing.values()].some((p) => p.players.size > 0);
}

/** A command on PATH, or null: read on every press, so installing pw-play needs no restart. */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The player's command line for this sound: pw-play's, else paplay's, else null. */
export function playerCommand(spec: SoundSpec): { command: string; args: string[] } | null {
  const volume = Math.max(0, Math.min(100, spec.volume)) / 100;
  if (onPath('pw-play')) {
    const args = ['--volume', volume.toFixed(3)];
    if (spec.node) args.push('--target', spec.node);
    return { command: 'pw-play', args: [...args, spec.file] };
  }
  if (onPath('paplay')) {
    // paplay's volume is 0–65536, where 65536 is the file's own level.
    const args = ['--client-name=Deckhand', `--volume=${Math.round(volume * 65536)}`];
    if (spec.node) args.push(`--device=${spec.node}`);
    return { command: 'paplay', args: [...args, spec.file] };
  }
  return null;
}

/** The file must be there to be played: said on the key, not left to the player's error. */
export async function checkFile(file: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new Error(`sound file ${file} is not there`);
  }
  if (!stat.isFile()) throw new Error(`sound file ${file} is not a file`);
}

/**
 * Start one player of this sound. Resolves once it has been running for
 * START_CONFIRM_MS, or has ended well within it (a short sound); rejects if it
 * could not start or ended with an error within it, with what it said.
 */
function startPlayer(id: string, spec: SoundSpec): Promise<void> {
  const command = playerCommand(spec);
  if (!command) return Promise.reject(new Error('cannot play sounds: neither pw-play nor paplay is installed (pw-play comes with PipeWire\'s tools, paplay with pactl)'));

  let entry = playing.get(id);
  if (!entry) {
    entry = { players: new Set(), looping: false };
    playing.set(id, entry);
  }
  const own = entry;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let said = '';
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve();
    };

    const player = spawn(command.command, command.args, { stdio: ['ignore', 'ignore', 'pipe'] });
    own.players.add(player);
    player.stderr?.on('data', (chunk: Buffer) => {
      // Kept short: only the last thing it said is reported.
      said = `${said}${chunk.toString()}`.slice(-400);
    });
    player.on('error', (err) => {
      own.players.delete(player);
      if (own.players.size === 0 && playing.get(id) === own) playing.delete(id);
      changed();
      settle(new Error(`cannot start ${command.command}: ${err.message}`));
    });
    player.on('spawn', () => {
      changed();
      deadline = setTimeout(() => settle(), START_CONFIRM_MS);
    });
    player.on('exit', (code, signal) => {
      own.players.delete(player);
      const ranMs = Date.now() - startedAt;
      if (stoppedByUs.has(player)) {
        settle();
      } else if (code !== 0 && signal === null) {
        const why = said.trim().split('\n').pop() ?? '';
        const message = `${command.command} could not play ${path.basename(spec.file)}${why ? `: ${why}` : ` (exit ${code})`}`;
        // A failure after the press was judged is only logged: the key's press
        // has been settled, and the face shows it is no longer playing.
        if (settled) console.error(`[sound] ${message}`);
        own.looping = false;
        settle(new Error(message));
      } else {
        settle();
        // Looping and not stopped: the next play, started by this one ending.
        if (own.looping && signal === null && ranMs >= MIN_LOOP_MS) {
          startPlayer(id, spec).catch((err: Error) => console.error(`[sound] the loop of ${path.basename(spec.file)} stopped: ${err.message}`));
          return;
        }
        if (own.looping && ranMs < MIN_LOOP_MS) {
          console.error(`[sound] not looping ${path.basename(spec.file)}: it played for ${ranMs} ms`);
          own.looping = false;
        }
      }
      if (own.players.size === 0 && playing.get(id) === own) playing.delete(id);
      changed();
    });
  });
}

/** Play a sound once more, beside any of it already playing. */
export function play(id: string, spec: SoundSpec): Promise<void> {
  return startPlayer(id, spec);
}

/** Play a sound over and over until it is stopped. */
export function loop(id: string, spec: SoundSpec): Promise<void> {
  const promise = startPlayer(id, spec);
  const entry = playing.get(id);
  if (entry) entry.looping = true;
  return promise;
}

/** Stop every player of one sound, and its loop. Returns whether anything was playing. */
export function stop(id: string): boolean {
  const entry = playing.get(id);
  if (!entry || entry.players.size === 0) return false;
  entry.looping = false;
  for (const player of entry.players) {
    stoppedByUs.add(player);
    player.kill('SIGTERM');
  }
  return true;
}

/** The editor's preview of a clip (sound.preview): one at a time, apart from every key's sounds. */
const PREVIEW = 'preview';
let previewFile: string | null = null;

/** Play a clip for the editor, stopping the clip it was previewing. */
export function preview(spec: SoundSpec): Promise<void> {
  stop(PREVIEW);
  previewFile = spec.file;
  return play(PREVIEW, spec);
}

export function stopPreview(): boolean {
  return stop(PREVIEW);
}

/** The clip the editor is previewing while it plays, or null. */
export function previewing(): string | null {
  return isPlaying(PREVIEW) ? previewFile : null;
}

/** Stop everything Deckhand is playing. Returns how many sounds were. */
export function stopAll(): number {
  let count = 0;
  for (const id of playing.keys()) if (stop(id)) count++;
  return count;
}
