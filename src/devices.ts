import type { DeckGeometry } from './geometry.js';
import type { LayoutDef } from './types.js';

/**
 * What the daemon needs from a deck, whatever drives it — the seam between
 * the daemon and its devices. A Stream Deck is one kind (drivers/hid.ts);
 * a virtual deck on a touchscreen will be another, and a module hub could
 * be a third. Nothing above this asks which kind it has.
 *
 * Controls are named by id, a short string: a Stream Deck's key 7 is "7",
 * so every config written so far stays valid. A virtual deck's ids are given
 * when its controls are made and never reused, so moving or resizing a
 * control never reshuffles what is on it.
 */
export interface DeckDevice {
  /** Stable identity: the config is keyed by it. A Stream Deck's serial number. */
  readonly id: string;
  /** Which driver it came from ("hid"), for logs. */
  readonly driver: string;
  /** Its controls and where they sit, from the device itself, never from a table. */
  readonly geometry: DeckGeometry;
  /** A control pressed or let go. Registered once, before anything is drawn. */
  onInput(listener: (event: ControlInput) => void): void;
  onError(listener: (err: unknown) => void): void;
  /** Show an image on a control that has a screen: raw RGBA at that screen's size. */
  draw(control: string, rgba: Buffer): Promise<void>;
  /** Blank every screen. Optional: not every device has screens to blank. */
  clear?(): Promise<void>;
  /** Optional: a device without a backlight to set has none. */
  setBrightness?(percent: number): Promise<void>;
  close(): Promise<void>;
  /**
   * Optional: a device whose controls the layout defines — a virtual deck,
   * whose panel can differ per profile. Called with each layout it is given
   * (attaching, a profile switch, a reload); returns its controls for that
   * layout, which replace `geometry` for the session. Pure: it only answers.
   * A Stream Deck has none: its controls are its own.
   */
  layoutFrom?(layout: LayoutDef): DeckGeometry;
  /** With layoutFrom: the controls the session now uses. Its screen is cleared, and drawn again key by key. */
  showGeometry?(geometry: DeckGeometry): void;
  /** Optional: the device asks for every control to be drawn again (its screen was resized, say). */
  onRedraw?(listener: () => void): void;
}

export interface ControlInput {
  control: string;
  edge: 'down' | 'up';
}

/** A device a driver can see, not yet opened. */
export interface FoundDevice {
  /** Its id, when the driver knows it without opening the device; a scan skips known ones by it. */
  id?: string;
  /** Open it. Resolves null (and logs why) when it cannot be opened or identified. */
  open(): Promise<DeckDevice | null>;
}

export interface DeckDriver {
  readonly name: string;
  /** Every device it can see now. Cheap enough for the 60-second safety scan. */
  list(): Promise<FoundDevice[]>;
  /** Optional: call back when a device may have come or gone, so the daemon rescans at once. Returns a stop function. */
  watch?(onChange: (why: string) => void): () => void;
}
