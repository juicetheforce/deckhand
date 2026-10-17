import fs from 'node:fs';
import path from 'node:path';
import type { TouchDeviceDef } from './types.js';

/**
 * Touchscreens and the evdev nodes they have, from /sys/class/input and
 * udev's database — no root, no helper running, a few small reads per node.
 *
 * **A virtual deck's touchscreen is recognised by its USB serial when it has
 * one** (the Xeneon Edge's controller: `9LQ0172005164`), **else by its
 * vendor and product and the port it hangs from** (udev's `ID_PATH`; the
 * 10.3" panel's ILITEK has no serial). The pairing tap is what links a
 * touchscreen to its screen: nothing else does on either machine measured. **Its reported physical size is never used**: both
 * controllers measured misreport it.
 *
 * A touchscreen's **siblings** are the other input nodes of the same physical
 * device — the ILITEK's "Mouse" twin is on another USB interface of the same
 * USB device. They are grabbed with it when the daemon may open them; the
 * udev rule grants touchscreens only: a sibling is a plain mouse to udev, and
 * a rule for it would grant every mouse.
 */

const INPUT_DIR = process.env.DECKHAND_INPUT_DIR ?? '/sys/class/input';
const UDEV_DATA_DIR = process.env.DECKHAND_UDEV_DATA_DIR ?? '/run/udev/data';
/** Where the device nodes are; a test points it at a scratch directory. */
const DEV_DIR = process.env.DECKHAND_DEV_INPUT_DIR ?? '/dev/input';
/** INPUT_PROP_DIRECT: the device's coordinates are the screen's — a touchscreen, not a touchpad. */
const INPUT_PROP_DIRECT = 0x02;

export interface InputNode {
  /** "event15" */
  node: string;
  /** "/dev/input/event15" */
  devnode: string;
  /** It reports an absolute position (ABS_X and ABS_Y): a touchscreen's "mouse" twin that does could carry a touch as a click. */
  absolute: boolean;
  name: string;
  touchscreen: boolean;
  /** Four hex digits, lower case. */
  vendor: string;
  product: string;
  serial?: string;
  /** udev's ID_PATH: the port it hangs from. */
  idPath?: string;
  /** The physical device it belongs to (a USB device, else its own parent): siblings share it. */
  physical: string;
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

/** udev's properties for a character device, "13:79". */
function udevProperties(dev: string, udevDir: string): Map<string, string> | null {
  const text = read(path.join(udevDir, `c${dev}`));
  if (text === null) return null;
  const props = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('E:')) continue;
    const eq = line.indexOf('=');
    if (eq > 2) props.set(line.slice(2, eq), line.slice(eq + 1));
  }
  return props;
}

/** The nearest directory above `from` holding `file` — a USB device holds idVendor. */
function ancestorWith(from: string, file: string): string | null {
  let dir = from;
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, file))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Every evdev node. */
export function listInputNodes(inputDir = INPUT_DIR, udevDir = UDEV_DATA_DIR): InputNode[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(inputDir);
  } catch {
    return [];
  }
  const nodes: InputNode[] = [];
  for (const node of entries.filter((n) => /^event\d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
    let real: string;
    try {
      real = fs.realpathSync(path.join(inputDir, node));
    } catch {
      continue;
    }
    const input = path.dirname(real);
    const dev = read(path.join(real, 'dev'));
    const vendor = read(path.join(input, 'id', 'vendor'));
    const product = read(path.join(input, 'id', 'product'));
    if (!dev || !vendor || !product) continue;
    const props = udevProperties(dev, udevDir);
    const direct = (parseInt(read(path.join(input, 'properties')) ?? '0', 16) & INPUT_PROP_DIRECT) !== 0;
    // The lowest word of the absolute-axis bitmap, last in the file: bits 0 and 1 are ABS_X and ABS_Y.
    const absWords = (read(path.join(input, 'capabilities', 'abs')) ?? '0').split(' ');
    const absolute = (parseInt(absWords[absWords.length - 1], 16) & 0x3) === 0x3;
    const usb = ancestorWith(path.dirname(input), 'idVendor');
    const serial = (usb ? read(path.join(usb, 'serial')) : null) || read(path.join(input, 'uniq')) || undefined;
    nodes.push({
      node,
      devnode: path.join(DEV_DIR, node),
      absolute,
      name: read(path.join(input, 'name')) ?? node,
      // udev's word when it has one; the kernel's "direct" property when its database is missing.
      touchscreen: props ? props.get('ID_INPUT_TOUCHSCREEN') === '1' : direct,
      vendor: vendor.toLowerCase(),
      product: product.toLowerCase(),
      serial,
      idPath: props?.get('ID_PATH') || undefined,
      physical: usb ?? path.dirname(input),
    });
  }
  return nodes;
}

/** Whether this process may open the node for reading. */
export function readable(node: InputNode): boolean {
  try {
    fs.accessSync(node.devnode, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** What a pairing remembers of a touchscreen: its serial when it has one, else its IDs and port. */
export function touchIdentity(node: InputNode): TouchDeviceDef {
  if (node.serial) return { vendor: node.vendor, product: node.product, serial: node.serial };
  return { vendor: node.vendor, product: node.product, ...(node.idPath ? { path: node.idPath } : {}) };
}

/** The touchscreen a pairing names, and its siblings; null when it is not connected. */
export function findTouch(nodes: InputNode[], touch: TouchDeviceDef): { touchscreen: InputNode; siblings: InputNode[] } | null {
  const touchscreen = nodes.find(
    (n) =>
      n.touchscreen &&
      n.vendor === touch.vendor.toLowerCase() &&
      n.product === touch.product.toLowerCase() &&
      (touch.serial !== undefined ? n.serial === touch.serial : touch.path !== undefined ? n.idPath === touch.path : true),
  );
  if (!touchscreen) return null;
  return { touchscreen, siblings: nodes.filter((n) => n !== touchscreen && n.physical === touchscreen.physical) };
}
