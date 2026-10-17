import fs from 'node:fs';
import path from 'node:path';

/**
 * The screens connected to this computer, and the key that recognises each
 * one — what a virtual deck's config is keyed by, as a Stream Deck's is by
 * its serial.
 *
 * Read from /sys/class/drm, which needs no root: each connector's `status`
 * and `edid`. Nothing is kept: a scan reads them again, and costs a handful
 * of small reads.
 *
 * **The key is `<maker>-<product>`, plus the EDID's text serial when it has
 * one** — `HPN-3469-CNK8231CGN`, `CRX-ed00-062626215656`, and a panel with no
 * text serial `GRA-6e4e`. **Never the numeric serial field**: three of four
 * screens measured, two identical HP E243s among them, report the same
 * placeholder there (16843009), and Deckhand cannot tell a placeholder from
 * a real one without a per-model table, which it never keeps. Identical
 * panels with no text serial share a key; the connector a deck was set up on
 * then tells them apart (findScreen). A screen with no EDID is keyed by its
 * connector alone.
 */

const DRM_DIR = process.env.DECKHAND_DRM_DIR ?? '/sys/class/drm';

export interface Edid {
  /** The three-letter PNP maker ID, "GRA". */
  maker: string;
  /** The product code, four hex digits, "6e4e". */
  product: string;
  /** The text serial descriptor, cleaned of anything not printable; absent when there is none. */
  serial?: string;
  /** The monitor name descriptor, "HD Display". */
  name?: string;
  /** The physical size, from the first detailed timing; 0 when not given. */
  widthMm: number;
  heightMm: number;
}

export interface Screen {
  /** The DRM connector, "DP-4": what the Wayland output is found by. */
  connector: string;
  /** What recognises it: see the top of this file. */
  key: string;
  edid: Edid | null;
}

/** Bytes 5–17 of a display descriptor: text ending at a newline, padded with spaces. Every byte that is not printable is dropped (the Xeneon Edge's serial carries a NUL), and the ends trimmed. */
function descriptorText(bytes: Buffer): string {
  let text = '';
  for (const b of bytes) {
    if (b === 0x0a) break;
    if (b >= 0x20 && b < 0x7f) text += String.fromCharCode(b);
  }
  return text.trim();
}

/** The parts of an EDID's base block Deckhand uses; null when it is not one. */
export function parseEdid(edid: Buffer): Edid | null {
  const header = Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
  if (edid.length < 128 || !edid.subarray(0, 8).equals(header)) return null;
  const id = edid.readUInt16BE(8);
  const letter = (v: number) => String.fromCharCode(64 + (v & 0x1f));
  const maker = letter(id >> 10) + letter(id >> 5) + letter(id);
  if (!/^[A-Z]{3}$/.test(maker)) return null;
  const product = edid.readUInt16LE(10).toString(16).padStart(4, '0');
  let serial: string | undefined;
  let name: string | undefined;
  let widthMm = 0;
  let heightMm = 0;
  for (const at of [54, 72, 90, 108]) {
    const d = edid.subarray(at, at + 18);
    if (d[0] !== 0 || d[1] !== 0) {
      // A detailed timing: the first gives the image size in mm.
      if (widthMm === 0 && heightMm === 0) {
        widthMm = d[12] | ((d[14] & 0xf0) << 4);
        heightMm = d[13] | ((d[14] & 0x0f) << 8);
      }
      continue;
    }
    if (d[3] === 0xff) serial = descriptorText(d.subarray(5, 18)) || undefined;
    if (d[3] === 0xfc) name = descriptorText(d.subarray(5, 18)) || undefined;
  }
  return { maker, product, serial, name, widthMm, heightMm };
}

/** A screen's key, from its EDID, or its connector when it has none. */
export function screenKey(edid: Edid | null, connector: string): string {
  if (!edid) return `output-${connector}`;
  // Only letters, digits, "-" and "_" in a key: a text serial can carry
  // anything printable.
  const serial = edid.serial?.replace(/[^A-Za-z0-9_-]/g, '');
  return [edid.maker, edid.product, serial].filter(Boolean).join('-');
}

/** Every connected screen. */
export function listScreens(drmDir = DRM_DIR): Screen[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(drmDir);
  } catch {
    return [];
  }
  const screens: Screen[] = [];
  for (const name of entries.sort()) {
    const match = /^card\d+-(.+)$/.exec(name);
    if (!match) continue;
    const dir = path.join(drmDir, name);
    try {
      if (fs.readFileSync(path.join(dir, 'status'), 'utf8').trim() !== 'connected') continue;
    } catch {
      continue;
    }
    let edid: Edid | null = null;
    try {
      edid = parseEdid(fs.readFileSync(path.join(dir, 'edid')));
    } catch {
      // no EDID file: keyed by connector
    }
    screens.push({ connector: match[1], key: screenKey(edid, match[1]), edid });
  }
  return screens;
}

/**
 * The screen a virtual deck is on: the one connected screen with its key; or,
 * when several share it (identical panels with no text serial), the one on
 * the connector it was set up on. Several with none on that connector cannot
 * be told apart: `ambiguous`, and nothing is shown — showing one person's
 * layout on whichever came first would swap them silently.
 */
export function findScreen(screens: Screen[], key: string, connector: string | undefined): Screen | 'ambiguous' | null {
  const matching = screens.filter((s) => s.key === key);
  if (matching.length === 0) return null;
  if (matching.length === 1) return matching[0];
  return matching.find((s) => s.connector === connector) ?? 'ambiguous';
}
