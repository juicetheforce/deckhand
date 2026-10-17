/**
 * Scratch sysfs for the virtual-deck tests: EDIDs and DRM connectors as
 * /sys/class/drm has them, and evdev nodes as /sys/class/input and udev's
 * database have them — what src/screens.ts and src/touchscreens.ts read.
 *
 *   const sys = fakeSysfs(root);   // root/drm, root/sys/class/input, root/udev
 *   await sys.plug('DP-4', 'connected', edid({ maker: 'GRA', product: '6e4e' }));
 *   await sys.usbDevice('pci0/usb3/3-2.3', '222a');
 *   await sys.inputNode({ event: 'event15', minor: 79, physical: …, … });
 *   await sys.unplugNode('event15');
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** A base EDID block: maker, product, the numeric serial field, a detailed timing with the size, and text descriptors. */
export function edid({ maker, product, numeric = 0x01010101, serial, name, widthMm = 0, heightMm = 0 }) {
  const b = Buffer.alloc(128);
  Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(b, 0);
  const code = (c) => c.charCodeAt(0) - 64;
  b.writeUInt16BE((code(maker[0]) << 10) | (code(maker[1]) << 5) | code(maker[2]), 8);
  b.writeUInt16LE(parseInt(product, 16), 10);
  b.writeUInt32LE(numeric, 12);
  // A detailed timing at 54: a pixel clock (not 0) and the size in mm.
  b.writeUInt16LE(14850, 54);
  b[54 + 12] = widthMm & 0xff;
  b[54 + 13] = heightMm & 0xff;
  b[54 + 14] = ((widthMm >> 8) << 4) | (heightMm >> 8);
  const text = (at, tag, value) => {
    b[at + 3] = tag;
    const bytes = Buffer.alloc(13, 0x20);
    const v = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    v.copy(bytes, 0);
    if (v.length < 13) bytes[v.length] = 0x0a;
    bytes.copy(b, at + 5);
  };
  if (serial !== undefined) text(72, 0xff, serial);
  else text(72, 0x10, '');
  if (name !== undefined) text(90, 0xfc, name);
  else text(90, 0x10, '');
  text(108, 0x10, '');
  return b;
}

export function fakeSysfs(root) {
  const DRM = path.join(root, 'drm');
  const SYS = path.join(root, 'sys');
  const INPUT = path.join(SYS, 'class/input');
  const UDEV = path.join(root, 'udev');
  const DEV = path.join(root, 'dev/input');
  return {
    drm: DRM,
    input: INPUT,
    udev: UDEV,
    /** Where the device nodes are: DECKHAND_DEV_INPUT_DIR. Plain files, readable unless a node says `readable: false`. */
    dev: DEV,
    /** A connector, connected or not, with an EDID or none. */
    /** `modes`, optional: the connector's mode list, preferred first ("1920x720"). */
    async plug(connector, status, edidBytes, modes) {
      const dir = path.join(DRM, `card1-${connector}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'status'), `${status}\n`);
      if (edidBytes) await fs.writeFile(path.join(dir, 'edid'), edidBytes);
      else await fs.rm(path.join(dir, 'edid'), { force: true });
      if (modes) await fs.writeFile(path.join(dir, 'modes'), modes.map((m) => `${m}\n`).join(''));
    },
    async unplugConnector(connector) {
      await fs.rm(path.join(DRM, `card1-${connector}`), { recursive: true, force: true });
    },
    /** A USB device: idVendor, and its serial when it has one. */
    async usbDevice(dir, vendor, serial) {
      await fs.mkdir(path.join(SYS, 'devices', dir), { recursive: true });
      await fs.writeFile(path.join(SYS, 'devices', dir, 'idVendor'), `${vendor}\n`);
      if (serial) await fs.writeFile(path.join(SYS, 'devices', dir, 'serial'), `${serial}\n`);
    },
    /**
     * One evdev node: devices/<physical>/<parent>/input/<input>/<event>,
     * linked from class/input, with udev's properties when given.
     */
    async inputNode({ event, minor, physical, parent, input, name, vendor, product, uniq = '', direct = false, abs = direct ? '260800000000003' : '0', readable = true, udev }) {
      const inputDir = path.join(SYS, 'devices', physical, parent, 'input', input);
      await fs.mkdir(path.join(inputDir, event), { recursive: true });
      await fs.mkdir(path.join(inputDir, 'id'), { recursive: true });
      await fs.writeFile(path.join(inputDir, 'name'), `${name}\n`);
      await fs.writeFile(path.join(inputDir, 'uniq'), `${uniq}\n`);
      await fs.writeFile(path.join(inputDir, 'id/vendor'), `${vendor}\n`);
      await fs.writeFile(path.join(inputDir, 'id/product'), `${product}\n`);
      await fs.writeFile(path.join(inputDir, 'properties'), direct ? '2\n' : '0\n');
      await fs.writeFile(path.join(inputDir, event, 'dev'), `13:${minor}\n`);
      await fs.mkdir(path.join(inputDir, 'capabilities'), { recursive: true });
      await fs.writeFile(path.join(inputDir, 'capabilities/abs'), `${abs}\n`);
      await fs.mkdir(DEV, { recursive: true });
      await fs.writeFile(path.join(DEV, event), '');
      await fs.chmod(path.join(DEV, event), readable ? 0o600 : 0o000);
      await fs.mkdir(INPUT, { recursive: true });
      await fs.rm(path.join(INPUT, event), { force: true });
      await fs.symlink(path.join(inputDir, event), path.join(INPUT, event));
      if (udev) {
        await fs.mkdir(UDEV, { recursive: true });
        await fs.writeFile(path.join(UDEV, `c13:${minor}`), Object.entries(udev).map(([k, v]) => `E:${k}=${v}`).join('\n') + '\nG:seat\n');
      }
    },
    async unplugNode(event) {
      await fs.rm(path.join(INPUT, event), { force: true });
    },
  };
}

/** A 10.3" panel's ILITEK touchscreen and its mouse twin, as measured: no serial at any level, the twin on another interface, unreadable as the udev rule leaves it. */
export const ILITEK_NODES = [
  { event: 'event15', minor: 79, physical: 'pci0/usb3/3-2.3', parent: '3-2.3:1.0/0003:222A:0001.001C', input: 'input68', name: 'ILITEK Multi-Touch-V3000', vendor: '222a', product: '0001', direct: true, udev: { ID_INPUT: 1, ID_INPUT_TOUCHSCREEN: 1, ID_PATH: 'pci-0000:00:14.0-usb-0:2.3:1.0' } },
  // An absolute mouse (ABS_X, ABS_Y, five buttons), as measured; not granted by the udev rule.
  { event: 'event16', minor: 80, physical: 'pci0/usb3/3-2.3', parent: '3-2.3:1.1/0003:222A:0001.001D', input: 'input69', name: 'ILITEK Multi-Touch-V3000 Mouse', vendor: '222a', product: '0001', abs: '3', readable: false, udev: { ID_INPUT: 1, ID_INPUT_MOUSE: 1, ID_PATH: 'pci-0000:00:14.0-usb-0:2.3:1.1' } },
];
export const ILITEK = { vendor: '222a', product: '0001', path: 'pci-0000:00:14.0-usb-0:2.3:1.0' };
