/**
 * Offline test for labels too wide for a key (src/label-fit.ts): each line is
 * cut to what fits by its measured width, ends in an ellipsis, and is fitted
 * on its own.
 *
 *   npm run build:ts && node scripts/smoke-labels.mjs
 */
import path from 'node:path';
import { REPO, check, failureCount } from './test/control-harness.mjs';

const { fitLine, measureLine, labelMeasureCount } = await import(path.join(REPO, 'dist/label-fit.js'));
const { renderButton } = await import(path.join(REPO, 'dist/render.js'));

const FONT = 14;
const room = (size) => size - 4;
const face = (label) => ({
  label,
  labelColor: '#ffffff',
  labelSize: FONT,
  labelPosition: 'bottom',
  background: '#101014',
  iconFit: 'cover',
});

console.log('a line that fits');
for (const size of [72, 96]) {
  check(`${size} px: a short line is unchanged`, (await fitLine('Queen', FONT, size)) === 'Queen');
}

console.log('a line that does not');
for (const size of [72, 96]) {
  const wide = await fitLine('WWWWWWWWWWWWWWWWWW', FONT, size);
  const narrow = await fitLine('iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii', FONT, size);
  check(`${size} px: both end in an ellipsis`, wide.endsWith('…') && narrow.endsWith('…'));
  check(`${size} px: cut by width, not by count (${wide.length - 1} W, ${narrow.length - 1} i)`, narrow.length > wide.length + 3);

  for (const text of ['Bohemian Rhapsody - Remastered 2011', 'WWWWWWWWWWWWWWWWWW', 'Mr. Blue Sky and more']) {
    const fitted = await fitLine(text, FONT, size);
    // The next longer cut that reads differently: a cut ending in a space is trimmed to the same text.
    const chars = Array.from(text);
    let oneMore = fitted;
    for (let n = Array.from(fitted).length - 1; oneMore === fitted; n++) oneMore = `${chars.slice(0, n).join('').trimEnd()}…`;
    check(`${size} px: "${fitted}" fits`, (await measureLine(fitted, FONT)) <= room(size));
    check(`${size} px: "${fitted}" is the longest start that fits`, (await measureLine(oneMore, FONT)) > room(size));
    check(`${size} px: "${fitted}" is the start of the line`, text.startsWith(fitted.slice(0, -1)));
  }
}

console.log('measurements are kept');
{
  await measureLine('Measured once', FONT);
  const before = labelMeasureCount();
  await measureLine('Measured once', FONT);
  check('a line measured before is not measured again', labelMeasureCount() === before);
}

console.log('each line of a key on its own');
for (const size of [72, 96]) {
  const title = 'Everything In Its Right Place';
  const fitted = await fitLine(title, FONT, size);
  const drawn = await renderButton(face(`${title}\nQueen`), size);
  const expected = await renderButton(face(`${fitted}\nQueen`), size);
  check(`${size} px: the key draws "${fitted}" over the full artist`, drawn.equals(expected));
  const shortened = await renderButton(face(`${fitted}\nQuee`), size);
  check(`${size} px: ...and the comparison can fail`, !drawn.equals(shortened));
}

console.log(failureCount() === 0 ? '\nlabels: all checks passed' : `\nlabels: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
