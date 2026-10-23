import type { DiscordApprovalState, DiscordStatus, ObsStatus, TwitchStatus, VtsApprovalState, VtsStatus } from '../../../src/control/protocol.js';

/**
 * What the settings window says about each integration, in one place: the
 * sidebar's status dot and the page's status line read the same answer, so
 * they cannot disagree. Pure — no React, no bridge — so it is tested
 * directly (test/settings-status.test.ts).
 *
 * The dots (the design mockups): hollow grey = not set up / not linked,
 * grey = waiting / linking, green = connected / linked, red = couldn't
 * connect. Each answer is the daemon's state, never a guess.
 */
export type Dot = 'unset' | 'waiting' | 'ok' | 'failed';

export interface StatusView {
  dot: Dot;
  /** The status line under the page's title. */
  text: string;
}

const NOT_SET_UP: StatusView = { dot: 'unset', text: 'Not set up' };
const CONNECTED: StatusView = { dot: 'ok', text: 'Connected' };
const FAILED: StatusView = { dot: 'failed', text: 'Couldn’t connect' };

/**
 * OBS. Set up and not connected is "waiting" — whether OBS is closed, or no
 * page a deck shows has an OBS key, so nothing needs it connected yet.
 */
export function obsView(status: ObsStatus): StatusView {
  if (!status.setUp) return NOT_SET_UP;
  if (status.connection === 'connected') return CONNECTED;
  if (status.connection === 'auth-failed') return FAILED;
  return { dot: 'waiting', text: 'Waiting for OBS' };
}

/** Connect's outcomes that mean it did not get access. */
const VTS_REFUSED_OUTCOMES = new Set<VtsApprovalState>(['denied', 'busy', 'not-running', 'api-off', 'unreachable', 'failed']);

/**
 * VTube Studio. Couldn't connect: VTS no longer accepts the saved token, or
 * — with none saved — the last Connect did not get one. A Connect again
 * that fails leaves the saved token as it was, so it does not turn a set-up
 * VTS red; its message says what happened.
 */
export function vtsView(status: VtsStatus): StatusView {
  if (status.connection === 'connected') return CONNECTED;
  if (status.connection === 'refused') return FAILED;
  if (!status.setUp) return VTS_REFUSED_OUTCOMES.has(status.approval.state) ? FAILED : NOT_SET_UP;
  return { dot: 'waiting', text: 'Waiting for VTube Studio' };
}

/** Twitch. Linking wins: Link again on a linked account is linking until it ends. */
export function twitchView(status: TwitchStatus): StatusView {
  if (status.linking.state === 'starting' || status.linking.state === 'waiting') return { dot: 'waiting', text: 'Linking…' };
  if (status.link === 'not-set-up') return { dot: 'unset', text: 'Not linked' };
  if (status.link === 'refused') return FAILED;
  return { dot: 'ok', text: `Linked as ${status.login}` };
}

/** Connect's outcomes that mean it did not get an authorization. */
const DISCORD_REFUSED_OUTCOMES = new Set<DiscordApprovalState>(['denied', 'not-running', 'failed']);

/**
 * Discord. Authorizing wins: Connect again is authorizing until it ends.
 * Set up and not connected follows OBS: "Waiting for Discord" — not
 * running, or no Discord key in the profile — except while its slow
 * handshake runs, which says it is connecting. Couldn't connect: Discord no
 * longer accepts the authorization, or — with none saved — the last
 * Connect did not get one.
 */
export function discordView(status: DiscordStatus): StatusView {
  if (status.approval.state === 'waiting') return { dot: 'waiting', text: 'Waiting for you to authorize' };
  if (status.approval.state === 'checking') return { dot: 'waiting', text: 'Connecting…' };
  if (!status.setUp) return DISCORD_REFUSED_OUTCOMES.has(status.approval.state) ? FAILED : NOT_SET_UP;
  if (status.connection === 'connected') return { dot: 'ok', text: status.userName ? `Connected as ${status.userName}` : 'Connected' };
  if (status.connection === 'refused') return FAILED;
  if (status.connection === 'connecting') return { dot: 'waiting', text: 'Connecting…' };
  return { dot: 'waiting', text: 'Waiting for Discord' };
}

/** What each permission Deckhand asks Twitch for shows as, in order: one permission covers title, category and markers. */
export const TWITCH_CHIPS: ReadonlyArray<{ chip: string; scope: string }> = [
  { chip: 'Title & category', scope: 'channel:manage:broadcast' },
  { chip: 'Markers', scope: 'channel:manage:broadcast' },
  { chip: 'Clips', scope: 'clips:edit' },
  { chip: 'Chat', scope: 'user:write:chat' },
];

/** The chips a link allows: all of them before linking (what it will ask for), the granted ones once linked. */
export function twitchChips(status: TwitchStatus): string[] {
  if (status.link === 'not-set-up') return TWITCH_CHIPS.map((c) => c.chip);
  return TWITCH_CHIPS.filter((c) => status.scopes.includes(c.scope)).map((c) => c.chip);
}

/** After an import: the icon count only when there is one. */
export function importedLine(written: number, keptPrevious: boolean): string {
  const icons = written === 0 ? '' : ` · ${written} icon${written === 1 ? '' : 's'} written`;
  return keptPrevious ? `Imported${icons}. Previous setup kept below.` : `Imported${icons}.`;
}
