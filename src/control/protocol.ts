import type { DeckGeometry } from '../geometry.js';

/**
 * The shapes the control socket sends, for
 * every client: the CLI and the editor.
 *
 * Types only, and this file must import nothing but other import-free type
 * files (geometry.ts is one). The editor's renderer imports it; a type-only
 * import of a file that imports Node or daemon code drags that code's types —
 * @types/node, sharp, dbus-next — into the renderer's type check, which then
 * lets renderer code use `process` or `Buffer` without complaint.
 */

/** The result of the most recent config load or reload. */
export interface ReloadResult {
  ok: boolean;
  /** ISO 8601 time. */
  at: string;
  error?: string;
}

/** Where rolling config backups are kept. Read from memory, so the socket never touches the disk for it. */
export interface BackupStatus {
  dir: string;
  count: number;
  /** ISO time of the newest backup, or null if there is none. */
  newest: string | null;
  /** The most recent failure, if the last attempt failed. */
  error?: string;
}

/** One entry in the control socket's device list. */
export interface PickableDevice {
  node: string;
  label: string;
  available: 'yes' | 'no' | 'unknown';
}

/** audio.sinks / audio.sources results; the "audio" event carries one of each. */
export interface AudioList {
  default: string;
  devices: PickableDevice[];
}

export interface DeckStatus {
  serial: string;
  connected: boolean;
  configured: boolean;
  profile?: string;
  page?: string;
  brightness?: number;
  /** Keys showing a preview, by control id. */
  previews?: string[];
  /** Keys latched down by a toggle, by control id, so the editor's grid can show it. */
  latched?: string[];
  /** Keys whose last press failed, on any page or profile. */
  failed?: KeyFailure[];
  /** A virtual deck's touch: whether touches work now, and if not, why (TouchState). */
  touch?: TouchState;
  /** A virtual deck turned off (the virtual.power action, or `virtual.power`): not connected, on purpose. Absent when on. */
  off?: true;
}

/**
 * A virtual deck's touch: `ready`; `not-paired` (no touchscreen in its
 * config); `missing` (its touchscreen is not connected); `opening` (being
 * opened); `failed` (it could not be opened or grabbed); `locked`,
 * `inactive` or `unknown` (the session is locked, not the active one, or its
 * state cannot be read — touches are refused, services/session-lock.ts).
 */
export type TouchState = 'ready' | 'not-paired' | 'missing' | 'opening' | 'failed' | 'locked' | 'inactive' | 'unknown';

/** `virtual.pair`: the screen tapped, and its touchscreen as the config remembers it (`decks[screen].virtual.touch`). */
export interface PairReply {
  connector: string;
  screen: string;
  touch: { vendor: string; product: string; serial?: string; path?: string };
  /** The touchscreen's name, for saying which was found. */
  touchName: string;
  /** The screen in pixels, as the helper found it on that output (rotation applied): a panel's canvas is laid out at this size. */
  width: number;
  height: number;
  /** Its physical size from the EDID, 0 when it gives none — trusted only when plausible (src/panel-presets.ts). */
  widthMm: number;
  heightMm: number;
  /** Its EDID name, when it has one. */
  name?: string;
}

/** `screens`: the connected screens, by what recognises each (src/screens.ts), and the touchscreens. */
export interface ScreensReply {
  screens: Array<{
    connector: string;
    key: string;
    maker?: string;
    product?: string;
    name?: string;
    serial?: string;
    widthMm?: number;
    heightMm?: number;
    /** Its native resolution, in pixels, when the kernel lists its modes. */
    width?: number;
    height?: number;
    /** A laptop's own screen (an eDP, LVDS or DSI connector). */
    builtIn: boolean;
    /** The virtual deck on it, by its key in "decks", if it is one. */
    deck: string | null;
  }>;
  touchscreens: Array<{ device: string; name: string; vendor: string; product: string; serial?: string; path?: string }>;
}

/** A key whose last press failed. It stays so until a press of it succeeds, or it is edited. */
export interface KeyFailure {
  profile: string;
  page: string;
  /** The key, by control id. */
  key: string;
  /** The failed action's error message, as logged. */
  error: string;
}

/** The part of "status" that the "state" event also carries. */
export interface StateSnapshot {
  activeProfile: { id: string; name: string | null } | null;
  decks: DeckStatus[];
  /** The clip `sound.preview` is playing, as it was given; absent when none is. */
  previewingSound?: string;
}

/** The "status" result. */
export type StatusResult = StateSnapshot & {
  protocol: number;
  pid: number;
  // backups is absent when talking to a daemon from before rolling backups.
  config: { path: string; lastReload: ReloadResult; backups?: BackupStatus };
};

/** The "decks" result. */
/** One installed application, as the `apps` command lists it. */
export interface AppListing {
  /** The desktop file ID: what an app key's `app` holds. */
  id: string;
  name: string;
  /** Its icon, resolved to a file at 96 px, or null when none can be found. */
  icon: string | null;
}

export type DecksResult = Array<{ serial: string } & DeckGeometry>;

/** The "profile.switch" result. */
export type SwitchResult = { active: { id: string; name: string | null }; changed: boolean };

/** Where an OBS output is, as a key shows it: obs-websocket's output states, folded. */
export type ObsOutputPhase = 'stopped' | 'starting' | 'live' | 'stopping' | 'reconnecting';

export type ObsConnection =
  /** Nothing needs OBS, and no connection has been tried. */
  | 'idle'
  /** No saved connection: OBS has not been set up in Deckhand's Settings. Nothing connects. */
  | 'not-set-up'
  | 'connecting'
  | 'connected'
  /** OBS is not running, its WebSocket server is off, or it went away. */
  | 'unavailable'
  /** OBS refused the password, or asked for one and none is set. */
  | 'auth-failed';

/** The "obs.status" result, and what the "obs" event carries. Never a secret: only whether a password is set. */
export interface ObsStatus {
  connection: ObsConnection;
  stream: ObsOutputPhase;
  record: ObsOutputPhase;
  recordPaused: boolean;
  /** A connection is saved: OBS keys can do something. */
  setUp: boolean;
  host: string | null;
  port: number | null;
  passwordSet: boolean;
}

/** How one attempt to reach OBS went: "obs.test", and "obs.credentials"'s `attempt`. */
export type ObsAttempt =
  | { ok: true; obsVersion: string }
  | { ok: false; reason: 'not-set-up' | 'not-running' | 'server-off' | 'unreachable' | 'auth' | 'no-password' | 'protocol'; message: string };

/**
 * The "obs.list" result: what an OBS key's picker offers — scenes, audio
 * inputs, or one scene's sources — in OBS's own order where it has one. Not
 * reachable is an answer, not an error: the picker says "Start OBS to choose".
 */
export type ObsList =
  | { ok: true; names: string[] }
  | { ok: false; reason: 'not-set-up' | 'unavailable' | 'auth' | 'not-found' | 'other'; message: string };

export type VtsConnection =
  /** Nothing needs VTube Studio, and no connection has been tried. */
  | 'idle'
  /** No saved token: VTube Studio has not been allowed in Deckhand's Settings. Nothing connects. */
  | 'not-set-up'
  | 'connecting'
  | 'connected'
  /** VTube Studio is not running, its API is off, or it went away. */
  | 'unavailable'
  /** VTube Studio no longer accepts the saved token: revoked in its plugin list. Never retried until Connect. */
  | 'refused';

/**
 * Where Settings' Connect is: asking VTube Studio for access happens in the
 * background, and the "vts" event says how it goes. `checking`: finding VTS
 * (a connection, then its broadcast if that fails). `waiting`: VTS is showing
 * its window and the person has not answered. Then one outcome, kept until
 * the next Connect: `approved` (the token is saved), `denied`, `busy` (VTS is
 * already showing a request), `not-running`, `api-off`, `unreachable`,
 * `failed`. `none`: never asked since the daemon started, or removed.
 */
export type VtsApprovalState = 'none' | 'checking' | 'waiting' | 'approved' | 'denied' | 'busy' | 'not-running' | 'api-off' | 'unreachable' | 'failed';

export interface VtsApproval {
  state: VtsApprovalState;
  /** What to tell the person, for every state but `none`. */
  message?: string;
}

/** The "vts.status" result, and what the "vts" event carries. Never the token: only whether VTube Studio is set up. */
export interface VtsStatus {
  connection: VtsConnection;
  /** The model loaded in VTube Studio, by ID; null when none, or not known (not connected). */
  modelId: string | null;
  /** A token is saved: VTube Studio keys can do something. */
  setUp: boolean;
  port: number | null;
  approval: VtsApproval;
}

/**
 * Whether Twitch is linked. `refused`: Twitch refused the last refresh —
 * revoked, lapsed, or a fault on Twitch's side, which look the same. The
 * link is kept and the hourly check keeps trying it; Remove or a new link
 * clears it.
 */
export type TwitchLink = 'not-set-up' | 'linked' | 'refused';

/**
 * Where linking is. It happens in the background; the "twitch" event says
 * how it goes. `starting`: asking Twitch for a code. `waiting`: the code is
 * shown, for the person to approve at twitch.tv/activate. Then one outcome,
 * kept until the next link: `approved`, `expired` (30 minutes passed),
 * `cancelled` (Deckhand's Cancel, or the client that asked went away),
 * `failed`. A Cancel on Twitch's own page never reaches Deckhand: the code
 * stays waiting until it expires (measured against Twitch). `none`:
 * never asked since the daemon started, or removed.
 */
export type TwitchLinkingState = 'none' | 'starting' | 'waiting' | 'approved' | 'expired' | 'cancelled' | 'failed';

export interface TwitchLinking {
  state: TwitchLinkingState;
  /** What to tell the person, for every state but `none`. */
  message?: string;
  /** While waiting: the code to type at twitch.tv/activate, and the page with it filled in. Not secret: the person types it. */
  userCode?: string;
  verificationUri?: string;
  /** While waiting: when the code expires, in ms since the epoch. */
  expiresAt?: number;
}

/** The "twitch.status" result, and what the "twitch" event carries. Never a token: only whether Twitch is linked, and as whom. */
export interface TwitchStatus {
  link: TwitchLink;
  /** A link is saved: Twitch keys can do something. */
  setUp: boolean;
  /** The linked account's login; null when not linked. */
  login: string | null;
  /** What the link allows, as Twitch granted it. */
  scopes: string[];
  linking: TwitchLinking;
}

/**
 * The "twitch.categories" result: Twitch's categories matching a search, by
 * ID, with the name to show. Not linked or unreachable is an answer, not an
 * error, as for OBS and VTube Studio.
 */
export type TwitchList =
  | { ok: true; items: Array<{ id: string; name: string }> }
  | { ok: false; reason: 'not-set-up' | 'refused' | 'unavailable' | 'other'; message: string };

/**
 * The "vts.list" result: what a VTube Studio key's picker offers — models,
 * one model's hotkeys, or the loaded model's expressions (`not-loaded` for
 * another) — by ID (an expression's is its file), with the name to show. Not reachable is an
 * answer, not an error, as for OBS.
 */
export type VtsList =
  | { ok: true; items: Array<{ id: string; name: string; type?: string; file?: string; note?: string }> }
  | { ok: false; reason: 'not-set-up' | 'unavailable' | 'refused' | 'not-found' | 'not-loaded' | 'other'; message: string };

export type DiscordConnection =
  /** Nothing needs Discord: the active profile has no Discord key. */
  | 'idle'
  /** Not authorized in Deckhand's Settings. Nothing connects. */
  | 'not-set-up'
  /** Discord is running and answering slowly: the handshake, or the authorization after it. Keys show they are connecting. */
  | 'connecting'
  | 'connected'
  /** Discord is not running (no socket where a supported Discord puts one), did not answer in time, or went away. Retried on the 60-second scan. */
  | 'unavailable'
  /** Discord no longer accepts Deckhand's authorization, and refreshing it was refused; or it does not know the application ID. Never retried until Connect again. */
  | 'refused';

/**
 * Where Settings' Connect is: authorizing happens in the background, and
 * the "discord" event says how it goes. `checking`: finding Discord and
 * waiting for it to answer. `waiting`: Discord is showing its Authorize
 * window. Then one outcome, kept until the next Connect: `approved` (the
 * tokens are saved), `denied`, `cancelled` (Deckhand's Cancel), `not-running`,
 * `failed`. `none`: never asked since the daemon started, or removed.
 */
export type DiscordApprovalState = 'none' | 'checking' | 'waiting' | 'approved' | 'denied' | 'cancelled' | 'not-running' | 'failed';

export interface DiscordApproval {
  state: DiscordApprovalState;
  /** What to tell the person, for every state but `none`. */
  message?: string;
}

/** The "discord.status" result, and what the "discord" event carries. Never a token: only whether Discord is set up, with which application, and as whom. */
export interface DiscordStatus {
  connection: DiscordConnection;
  /** An authorization is saved: Discord keys can do something. */
  setUp: boolean;
  /** The application ID it was made with; null when not set up. Not secret: the person copied it from the Developer Portal. */
  clientId: string | null;
  /** The Discord account that allowed it, by name; null when not set up. */
  userName: string | null;
  approval: DiscordApproval;
}

/**
 * The "discord.list" result: what a Discord key's picker offers — your
 * servers, one server's voice channels, or the people in the voice channel
 * you are in now — by ID, with the name to show. Not reachable is an answer,
 * not an error, as for OBS and VTube Studio.
 */
export type DiscordList =
  | { ok: true; items: Array<{ id: string; name: string }> }
  | { ok: false; reason: 'not-set-up' | 'unavailable' | 'connecting' | 'refused' | 'no-channel' | 'other'; message: string };
