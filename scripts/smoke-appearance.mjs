/**
 * Offline test for round 4, appearance for every deck (scope §7): the icon
 * scale's one rule (src/icon-scale.ts) and the retired iconFit's conversion
 * (src/icon-fit.ts); the image limits on icons (src/image-limits.ts); the
 * header reader the editor converts with (src/image-size.ts) against sharp;
 * the label font (src/label-fit.ts); and Touch feedback's pressed look, drawn
 * by a real DeckSession on a touch and its lift only.
 *
 *   npm run build:ts && node scripts/smoke-appearance.mjs
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

// Fakes first: src/input.js reads DECKHAND_INPUT_BIN when it is imported, and a
// real helper would type into the desktop.
process.env.DECKHAND_INPUT_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), 'test/fake-input-helper.mjs');
const { REPO, check, failureCount, sleep, DeckSession, KeyFailures, validateConfig } = await import('./test/control-harness.mjs');

const { drawnSize, coverScale, wholeImageMark, ICON_SCALE } = await import(path.join(REPO, 'dist/icon-scale.js'));
const { migrateIconFit, legacyIconFit, iconFilesToSize, CONFIG_VERSION } = await import(path.join(REPO, 'dist/icon-fit.js'));
const { imageSize } = await import(path.join(REPO, 'dist/image-size.js'));
const { renderButton, renderFace, clearRenderCache, PRESSED_SCALE } = await import(path.join(REPO, 'dist/render.js'));
const { measureLine, labelStyle } = await import(path.join(REPO, 'dist/label-fit.js'));
const { geometryOfPanel } = await import(path.join(REPO, 'dist/geometry.js'));

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'dh-appearance-'));
const BG = '#101014';
const display = (extra = {}) => ({ labelColor: '#ffffff', labelSize: 14, labelPosition: 'bottom', background: BG, builtinIconSize: 45.5, ...extra });

/** A plain red image of a size, written as `name`. */
async function image(name, width, height, format = 'png') {
  const file = path.join(TMP, name);
  let s = sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } });
  s = format === 'jpeg' ? s.jpeg() : format === 'webp' ? s.webp() : format === 'tiff' ? s.tiff() : format === 'gif' ? s.gif() : s.png();
  await s.toFile(file);
  return file;
}

/** Where the red is on a raw RGBA face: its box, in pixels. */
function redBox(rgba, width, height) {
  let l = width, r = -1, t = height, b = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (rgba[i] > 200 && rgba[i + 1] < 60 && rgba[i + 2] < 60 && rgba[i + 3] > 200) {
      l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
    }
  }
  return r < 0 ? null : { left: l, top: t, width: r - l + 1, height: b - t + 1 };
}

console.log('the one rule: at 100% the whole image fits the box, centred');
{
  check('drawnSize: a 2:1 image in a square box fits its width', JSON.stringify(drawnSize({ width: 200, height: 100 }, { width: 96, height: 96 }, 100)) === '{"width":96,"height":48}');
  check('…a square image on a wide box is sized by the shorter side', JSON.stringify(drawnSize({ width: 56, height: 56 }, { width: 318, height: 135 }, 100)) === '{"width":135,"height":135}');
  check('…scaled from there, never from the image', JSON.stringify(drawnSize({ width: 10, height: 10 }, { width: 96, height: 96 }, 50)) === '{"width":48,"height":48}');
  check('the range is 20–200 in steps of 5', ICON_SCALE.min === 20 && ICON_SCALE.max === 200 && ICON_SCALE.step === 5);

  const wide = await image('wide.png', 200, 100);
  const at = async (scale) => redBox(await renderButton(display({ icon: wide, iconScale: scale }), 96, true), 96, 96);
  const full = await at(100);
  check(`a 2:1 image at 100%: its whole width, half the height, centred (${JSON.stringify(full)})`, full && full.width === 96 && full.height === 48 && full.top === 24);
  const zoomed = await at(200);
  check(`…at 200%: it fills the key, its sides cut (${JSON.stringify(zoomed)})`, zoomed && zoomed.width === 96 && zoomed.height === 96);
  const small = await at(50);
  check(`…at 50%: half that, centred (${JSON.stringify(small)})`, small && small.width === 48 && small.height === 24 && small.left === 24 && small.top === 36);
  const plain = await renderButton(display({ icon: wide }), 96, true);
  check('a file with no scale is drawn at 100%', Buffer.compare(plain, await renderButton(display({ icon: wide, iconScale: 100 }), 96, true)) === 0);

  // A square image on a wide control: today's look, the square at the shorter side.
  const square = await image('square.png', 56, 56);
  const face = await renderFace(display({ icon: square }), { width: 318, height: 135, shape: 'rectangle', radius: 27 }, true);
  const onWide = redBox(face, 318, 135);
  check(`a square image on a 318 × 135 button: a 135 px square in the middle, as before (${JSON.stringify(onWide)})`, onWide && onWide.width === 135 && onWide.height === 135 && onWide.left === 91);

  // A built-in on a wide control at the default size is never cropped.
  const ink = (rgba, w, h) => {
    let t = h, b = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(rgba[i] - 0x10) + Math.abs(rgba[i + 1] - 0x10) + Math.abs(rgba[i + 2] - 0x14) > 24) { t = Math.min(t, y); b = Math.max(b, y); }
    }
    return b - t + 1;
  };
  const glyph = ink(await renderFace(display({ icon: 'builtin:mic' }), { width: 300, height: 100 }, true), 300, 100);
  check(`a built-in on a 300 × 100 button follows the global size of the shorter side, uncut: ${glyph} px tall`, glyph > 25 && glyph <= 47);
  const own = ink(await renderFace(display({ icon: 'builtin:mic', iconScale: 90 }), { width: 300, height: 100 }, true), 300, 100);
  check(`…and its own scale, once set, instead: ${own} px tall`, own > glyph + 25);
}

console.log('the retired iconFit: cover kept as the number that draws it');
{
  check('coverScale: a square image is 100 on any box', coverScale({ width: 56, height: 56 }, { width: 96, height: 96 }) === 100 && coverScale({ width: 56, height: 56 }, { width: 318, height: 135 }) === 100);
  check('…a 2:1 image on a square key is 200, a 4:3 one 133.3', coverScale({ width: 200, height: 100 }, { width: 1, height: 1 }) === 200 && coverScale({ width: 400, height: 300 }, { width: 1, height: 1 }) === 133.3);
  check('…a 3:1 image is kept to 200', coverScale({ width: 300, height: 100 }, { width: 1, height: 1 }) === 200);

  const wide = path.join(TMP, 'wide.png');
  const old = await sharp(await sharp(await fs.readFile(wide)).resize(96, 96, { fit: 'cover' }).png().toBuffer());
  const oldFace = await sharp({ create: { width: 96, height: 96, channels: 4, background: BG } }).composite([{ input: await old.png().toBuffer() }]).raw().toBuffer();
  const asCover = await renderButton(display({ icon: wide, iconScale: 'cover' }), 96, true);
  check('"cover" draws exactly what the old crop drew', Buffer.compare(asCover, oldFace) === 0);

  const config = {
    defaults: { iconFit: 'cover' },
    profiles: { p: { layouts: {
      SD: { pages: { m: { buttons: {
        0: { icon: wide, action: { type: 'hotkey', keys: 'a' } },
        1: { icon: path.join(TMP, 'square.png') },
        2: { icon: wide, iconFit: 'contain' },
        3: { icon: 'builtin:mic' },
        4: { icon: wide, iconScale: 60 },
        5: { icon: path.join(TMP, 'tall-3x1.png') },
      } } } },
      V: { pages: { v: { panel: { size: { width: 400, height: 200 }, controls: [{ id: 'c', x: 0, y: 0, w: 318, h: 135 }] }, buttons: { c: { icon: wide } } } } },
    } } },
  };
  const sizes = { [wide]: { width: 200, height: 100 }, [path.join(TMP, 'square.png')]: { width: 56, height: 56 }, [path.join(TMP, 'tall-3x1.png')]: { width: 100, height: 300 } };
  check('the files to size: every icon file, no built-in', JSON.stringify(iconFilesToSize(config).sort()) === JSON.stringify(Object.keys(sizes).sort()));
  const daemonView = structuredClone(config);
  legacyIconFit(daemonView);
  const dv = daemonView.profiles.p.layouts.SD.pages.m.buttons;
  check('the daemon reads an older config in memory: each key\'s fit explicit, the default gone', dv[0].iconFit === 'cover' && dv[2].iconFit === 'contain' && dv[4].iconFit === undefined && daemonView.defaults.iconFit === undefined);
  check('the converted config: changed', migrateIconFit(config, (p) => sizes[p] ?? null) === true);
  const b = config.profiles.p.layouts.SD.pages.m.buttons;
  check('a 2:1 image under cover becomes 200', b[0].iconScale === 200 && b[0].iconFit === undefined);
  check('a square image gets no number', b[1].iconScale === undefined && b[1].iconFit === undefined);
  check('contain becomes 100%, stored as nothing', b[2].iconScale === undefined && b[2].iconFit === undefined);
  check('a built-in gets nothing', b[3].iconScale === undefined);
  check('a key\'s own scale is kept', b[4].iconScale === 60);
  check('a 1:3 image is kept to 200', b[5].iconScale === 200);
  const v = config.profiles.p.layouts.V.pages.v.buttons.c;
  // The old crop to the square at the shorter side is no scale at all; the size is kept (custom layouts are unreleased).
  check(`a 2:1 image on a 318 × 135 control: drawn the same size, so nothing written (${v.iconScale})`, v.iconScale === undefined && coverScale({ width: 200, height: 100 }, { width: 318, height: 135 }) === 100);
  check('the version is written, and defaults.iconFit dropped', config.version === CONFIG_VERSION && config.defaults.iconFit === undefined);
  check('converting again changes nothing', migrateIconFit(config, () => ({ width: 1, height: 9 })) === false && b[1].iconScale === undefined);
  const daemonAfter = structuredClone(config);
  daemonAfter.profiles.p.layouts.SD.pages.m.buttons[1].iconFit = 'cover';
  legacyIconFit(daemonAfter);
  check('in a converted config a leftover iconFit is ignored', daemonAfter.profiles.p.layouts.SD.pages.m.buttons[1].iconFit === undefined);
}

console.log('validation');
{
  const refused = (c, field) => {
    try {
      validateConfig({ profiles: { p: { layouts: { S: { pages: { m: { buttons: {} } } } } } }, ...c });
      return false;
    } catch (err) {
      return err.message.includes(field);
    }
  };
  const key = (button) => ({ profiles: { p: { layouts: { S: { pages: { m: { buttons: { 0: button } } } } } } } });
  check('iconScale 20–200, a number', refused(key({ iconScale: 19 }), 'iconScale') && refused(key({ iconScale: 201 }), 'iconScale') && refused(key({ iconScale: '100' }), 'iconScale') && !refused(key({ iconScale: 20 }), 'iconScale') && !refused(key({ iconScale: 133.3 }), 'iconScale'));
  check('version: 2 or absent', refused({ version: 3 }, 'version') && refused({ version: '2' }, 'version') && !refused({ version: 2 }, 'version'));
  check('labelFont: a family name, nothing that could end its CSS string', refused({ defaults: { labelFont: "a'b" } }, 'labelFont') && refused({ defaults: { labelFont: 'a<b' } }, 'labelFont') && refused({ defaults: { labelFont: 'a}b' } }, 'labelFont') && refused({ defaults: { labelFont: ' ' } }, 'labelFont') && !refused({ defaults: { labelFont: 'Noto Sans' } }, 'labelFont'));
  check('touchFeedback: true or false', refused({ defaults: { touchFeedback: 'no' } }, 'touchFeedback') && !refused({ defaults: { touchFeedback: false } }, 'touchFeedback'));
}

console.log('the mark: where the whole image becomes visible, by shape');
{
  const sq = { width: 10, height: 10 };
  check('a square image on a square key: 100', wholeImageMark(sq, { w: 96, h: 96 }) === 100);
  check(`…in a circle: 70 (1/√2, rounded down): ${wholeImageMark(sq, { w: 120, h: 120, shape: 'round' })}`, wholeImageMark(sq, { w: 120, h: 120, shape: 'round' }) === 70);
  // Board 25b's 63% was against "covers the box" (the 120 px height); on the one rule it is against the 104 px width.
  const hex = wholeImageMark(sq, { w: 104, h: 120, shape: 'hexagon' });
  check(`…in a regular hexagon: 73 (76 px of 104): ${hex}`, hex === 73);
  check('a 2:1 image in a square key: 100, its whole width already fits', wholeImageMark({ width: 20, height: 10 }, { w: 96, h: 96 }) === 100);
  const pill = wholeImageMark(sq, { w: 300, h: 100, radius: 50 });
  check(`a square image on a pill: the box fits it at 100, the round ends don't reach it: ${pill}`, pill === 100);
}

console.log('the image limits on icons: refused with the reason, never blank');
{
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  const tiff = await image('photo.tiff', 20, 20, 'tiff');
  const huge = await image('huge.png', 5000, 10);
  const placeholder = await renderButton(display({ icon: 'builtin:missing' }), 96);
  for (const [file, words] of [[tiff, "photo.tiff isn't a PNG, JPEG, WebP, GIF or SVG."], [huge, 'huge.png is too large: 5000 × 10 px. The limit is 4096 px on the longer side.']]) {
    clearRenderCache();
    const face = await renderButton(display({ icon: file }), 96);
    check(`${path.basename(file)}: the deck shows the missing icon, not a blank key`, Buffer.compare(face, placeholder) === 0);
    check(`…and the log says why: "${words}"`, logged.some((l) => l.includes(words)));
    let strict = '';
    await renderButton(display({ icon: file }), 96, true).catch((err) => (strict = err.message));
    check('…as does a strict render (the preview)', strict.includes(words));
  }
  console.error = error;
  const fine = await image('ok.webp', 4096, 100, 'webp');
  check('4096 px on the longer side is within the limit', redBox(await renderButton(display({ icon: fine }), 96, true), 96, 96) !== null);
}

console.log('the editor\'s size reader agrees with sharp');
{
  const cases = [
    await image('s.png', 37, 21), await image('s.jpg', 300, 41, 'jpeg'), await image('s.gif', 5, 77, 'gif'), await image('s.webp', 129, 64, 'webp'),
  ];
  // Lossless and with alpha (VP8L, VP8X).
  const lossless = path.join(TMP, 'l.webp');
  await sharp({ create: { width: 333, height: 17, channels: 4, background: { r: 0, g: 9, b: 0, alpha: 0.5 } } }).webp({ lossless: true }).toFile(lossless);
  cases.push(lossless);
  const vp8x = path.join(TMP, 'x.webp');
  await sharp({ create: { width: 210, height: 90, channels: 4, background: { r: 0, g: 9, b: 0, alpha: 0.5 } } }).webp({ quality: 50, alphaQuality: 50 }).toFile(vp8x);
  cases.push(vp8x);
  const svgs = {
    'wh.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>',
    'vb.svg': '<?xml version="1.0"?><svg viewBox="0 0 24 12" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="12"/></svg>',
    'px.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="30px" height="90px" viewBox="0 0 1 3"><rect width="1" height="3"/></svg>',
  };
  for (const [name, text] of Object.entries(svgs)) {
    await fs.writeFile(path.join(TMP, name), text);
    cases.push(path.join(TMP, name));
  }
  cases.push(path.join(REPO, 'assets/icons/mic.svg'));
  for (const file of cases) {
    const data = await fs.readFile(file);
    const mine = imageSize(data);
    const theirs = await sharp(data).metadata();
    const ratio = (s) => s.width / s.height;
    check(`${path.basename(file)}: ${mine && `${mine.width} × ${mine.height}`} (sharp: ${theirs.width} × ${theirs.height})`, mine !== null && Math.abs(ratio(mine) - ratio(theirs)) < 0.01);
  }
  check('anything else: null', imageSize(Buffer.from('hello')) === null && imageSize(await fs.readFile(path.join(TMP, 'photo.tiff'))) === null);
}

console.log('the label font');
{
  check('the style names the family, with the default after it', labelStyle(14, '#fff', 'DejaVu Sans Mono').includes("font-family: 'DejaVu Sans Mono', sans-serif;") && labelStyle(14, '#fff').includes('font-family: sans-serif;'));
  const mono = await measureLine('iiiiiiii', 20, 'DejaVu Sans Mono');
  const plain = await measureLine('iiiiiiii', 20);
  check(`a monospaced font measures wider "i"s: ${mono} px against ${plain} — the widths are kept per font`, mono > plain + 20);
  const missing = await renderButton(display({ label: 'SPRINT', labelFont: 'No Such Font At All' }), 96);
  const fallback = await renderButton(display({ label: 'SPRINT' }), 96);
  check('a font that is not installed draws the default', Buffer.compare(missing, fallback) === 0);
  const chosen = await renderButton(display({ label: 'SPRINT', labelFont: 'DejaVu Sans Mono' }), 96);
  check('…and an installed one draws differently (the check can fail)', Buffer.compare(chosen, fallback) !== 0);
}

console.log('the pressed look');
{
  const box = { width: 120, height: 120, shape: 'round', outline: true };
  const rest = await renderFace(display({ background: '#204060' }), box);
  const pressed = await renderFace(display({ background: '#204060', pressed: true }), box);
  const px = (rgba, x, y) => [...rgba.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4)];
  const [r0, g0, b0] = px(rest, 60, 60);
  const [r1, g1, b1, a1] = px(pressed, 60, 60);
  check(`lighter: ${[r0, g0, b0]} → ${[r1, g1, b1]}`, r1 > r0 + 20 && g1 > g0 + 20 && b1 > b0 + 20 && a1 === 255);
  // At rest the circle reaches the box's edge at the middle of a side; pressed, it is drawn at 95%, so that pixel is clear.
  check('drawn at 95%: the edge of the shape pulled in, clear outside it', px(rest, 60, 1)[3] === 255 && px(pressed, 60, 1)[3] === 0 && PRESSED_SCALE === 0.95);
  const lit = (rgba) => {
    let n = 0;
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) if (rgba[(y * 120 + x) * 4 + 3] > 0) n++;
    return n;
  };
  check(`…still inside its own shape: ${lit(pressed)} pixels against ${lit(rest)}`, lit(pressed) < lit(rest) && lit(pressed) > lit(rest) * 0.85);
}

console.log('touch feedback through a DeckSession: drawn on the touch and the lift, nothing else');
{
  const panel = { size: { width: 400, height: 200 }, controls: [{ id: 'a', x: 0, y: 0, w: 120, h: 120, shape: 'round' }, { id: 'b', x: 200, y: 0, w: 120, h: 120 }] };
  const makeDevice = (geometry) => {
    const d = {
      id: 'TOUCH', driver: 'fake', geometry, draws: [], listener: null,
      onInput(l) { d.listener = l; },
      onError() {},
      async draw(control, rgba) { d.draws.push({ control, rgba }); },
      async clear() {},
      async close() {},
      press(control) { d.listener({ control, edge: 'down' }); },
      lift(control) { d.listener({ control, edge: 'up' }); },
    };
    return d;
  };
  const session = async (device, defaults) => {
    const s = new DeckSession(device, {
      serial: 'TOUCH', hardware: {}, defaults, switchProfile: async () => {}, failures: new KeyFailures(), profileOf: () => 'p',
      layout: { pages: { m: { buttons: { a: { label: 'A' } } } } },
    });
    await s.start();
    await sleep(300);
    return s;
  };
  const virtual = makeDevice(geometryOfPanel(panel, 'Panel'));
  const s = await session(virtual, {});
  const drawn = virtual.draws.length;
  virtual.press('a');
  await sleep(300);
  const onPress = virtual.draws.slice(drawn);
  check(`a touch draws that control once, pressed (${onPress.map((d) => d.control)})`, onPress.length === 1 && onPress[0].control === 'a' && onPress[0].rgba[(60 * 120 + 60) * 4] > 0x10 + 20);
  virtual.lift('a');
  await sleep(300);
  const onLift = virtual.draws.slice(drawn + 1);
  check('its lift draws it at rest again, once', onLift.length === 1 && onLift[0].control === 'a' && Buffer.compare(onLift[0].rgba, virtual.draws.find((d) => d.control === 'a').rgba) === 0);
  virtual.press('b');
  await sleep(300);
  check('an empty control is pressed too: it is a button on the screen', virtual.draws.slice(drawn + 2).some((d) => d.control === 'b'));
  virtual.lift('b');
  await sleep(1200);
  const before = virtual.draws.length;
  await sleep(1500);
  check('at rest nothing more is drawn: no timer of its own (the render tick redraws only changed faces)', virtual.draws.length === before);
  // A font or key colour change is a config reload: each key drawn once, then nothing.
  const layout = { pages: { m: { buttons: { a: { label: 'A' } } } } };
  for (const [what, defaults] of [['a label font', { labelFont: 'DejaVu Sans Mono' }], ['a key colour', { labelFont: 'DejaVu Sans Mono', background: '#4a1f2b' }]]) {
    const from = virtual.draws.length;
    await s.reconfigure({}, layout, defaults, true);
    await sleep(300);
    const redrawn = virtual.draws.slice(from).map((d) => d.control).sort().join();
    await sleep(1500);
    check(`${what} redraws each key once, then nothing on a clock (${redrawn})`, redrawn === 'a,b' && virtual.draws.length === from + 2);
  }
  const centre = (60 * 120 + 60) * 4;
  check('…and the key colour is the empty control\'s fill', virtual.draws.some((d) => d.control === 'b' && d.rgba[centre] === 0x4a && d.rgba[centre + 1] === 0x1f && d.rgba[centre + 2] === 0x2b));
  await s.close();

  const off = makeDevice(geometryOfPanel(panel, 'Panel'));
  const s2 = await session(off, { touchFeedback: false });
  const n = off.draws.length;
  off.press('a');
  off.lift('a');
  await sleep(300);
  check('Touch feedback off: a touch draws nothing', off.draws.length === n);
  await s2.close();

  const streamDeck = makeDevice({ model: 'fake', productName: 'Fake', keyCount: 2, units: 'cells', iconSize: 72, rows: 1, columns: 2, unsupported: [], keys: [{ id: '0', row: 0, column: 0, x: 0, y: 0, w: 1, h: 1, width: 72, height: 72 }, { id: '1', row: 0, column: 1, x: 1, y: 0, w: 1, h: 1, width: 72, height: 72 }] });
  const s3 = new DeckSession(streamDeck, { serial: 'SD', hardware: {}, defaults: {}, switchProfile: async () => {}, failures: new KeyFailures(), profileOf: () => 'p', layout: { pages: { m: { buttons: { 0: { label: 'A' } } } } } });
  await s3.start();
  await sleep(300);
  const m = streamDeck.draws.length;
  streamDeck.press('0');
  streamDeck.lift('0');
  await sleep(300);
  check('a Stream Deck key is never drawn pressed, whatever the setting', streamDeck.draws.length === m);
  await s3.close();
}

await fs.rm(TMP, { recursive: true, force: true });
const failed = failureCount();
console.log(failed === 0 ? 'appearance: all checks passed' : `appearance: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
