/**
 * Multi action's steps (inspector/MultiForm.tsx), as pure functions with no
 * DOM, so test/renderer-model.test.ts runs them in Node.
 */
import type { ActionDef } from '../../../src/types.js';
import { actionDurationMs, formatDuration } from '../shared/durations.js';
import { keycaps } from '../shared/keys.js';
import { actionEditable, actionIncomplete, type Choice } from './model.js';

/**
 * What a step can be. Not Multi (no nesting), not Press/Release (it needs a
 * release, which a step has not got), and not Clock, Nothing or Now playing,
 * which do nothing useful in a sequence. A hand-written step of another kind
 * is kept, shown read-only, and can still be moved, delayed or removed.
 */
export const STEP_TYPES: readonly string[] = [
  'hotkey',
  'text',
  'command',
  'page',
  'profile',
  'brightness',
  'media.control',
  'audio.sink',
  'audio.source',
  'audio.cycle',
  'audio.micMute',
  'audio.volume',
  'audio.mute',
];

/** A step without its delay: what its own form edits. */
export function withoutDelay(step: ActionDef): ActionDef {
  const { delayMs: _delay, ...rest } = step;
  return rest as ActionDef;
}

export function stepEditable(step: ActionDef): boolean {
  return STEP_TYPES.includes(step.type) && actionEditable({ action: withoutDelay(step) }, step.type);
}

/** One line saying what a step does, for its row. */
export function stepSummary(step: ActionDef, pages: Choice[], profiles: Choice[]): string {
  if (actionIncomplete(step)) return 'not set up';
  const name = (list: Choice[], id: unknown) => list.find((c) => c.id === id)?.label ?? String(id);
  switch (step.type) {
    case 'hotkey':
      return Array.isArray(step.keys) ? step.keys.map((k) => keycaps(String(k)).join('+')).join(', then ') : keycaps(String(step.keys)).join('+');
    case 'text': {
      const text = String(step.text);
      return `“${text.length > 24 ? `${text.slice(0, 23)}…` : text}”`;
    }
    case 'command':
      return String(step.command ?? (Array.isArray(step.exec) ? step.exec.join(' ') : ''));
    case 'page':
      return step.back === true ? 'back' : `to ${name(pages, step.to)}`;
    case 'profile':
      return `to ${name(profiles, step.to)}`;
    case 'brightness':
      return typeof step.value === 'number' ? `set to ${step.value}%` : `${Number(step.delta) > 0 ? '+' : '−'}${Math.abs(Number(step.delta))}%`;
    case 'media.control':
      return String(step.method ?? 'playpause');
    case 'audio.sink':
    case 'audio.source':
      return String(step.label || step.node || step.match || '');
    case 'audio.cycle':
      return `${Array.isArray(step.devices) ? step.devices.length : Array.isArray(step.matches) ? step.matches.length : 0} outputs`;
    case 'audio.volume': {
      const delta = typeof step.delta === 'number' ? step.delta : 5;
      return `${delta > 0 ? '+' : '−'}${Math.abs(delta)}%`;
    }
    default:
      return '';
  }
}

/** "delays 750 ms · about 1.2 s total" (scope §10: both figures, because each combo itself takes time). */
export function multiTotal(steps: readonly ActionDef[]): string {
  const delays = steps.reduce((ms, s) => ms + (typeof s.delayMs === 'number' ? s.delayMs : 0), 0);
  const total = steps.reduce((ms, s) => ms + actionDurationMs(withoutDelay(s)), delays);
  return delays > 0 ? `delays ${formatDuration(delays)} · about ${formatDuration(total)} total` : `about ${formatDuration(total)} total`;
}

