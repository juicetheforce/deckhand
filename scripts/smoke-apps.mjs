/**
 * Offline test for the app action: desktop entries found where the desktop
 * finds them, icon names resolved through a theme, the app's icon drawn as a
 * key's default, and the launch going through gio and systemd-run --scope.
 * Everything is a scratch directory — HOME, XDG_DATA_HOME, XDG_DATA_DIRS,
 * XDG_CONFIG_HOME — and PATH holds only fakes: scripts/test/fake-gio.mjs,
 * fake-gsettings.mjs and fake-systemd-run.mjs, which starts nothing.
 *
 *   npm run build:ts && node scripts/smoke-apps.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { FakeDeck, REPO, check, connect, failureCount, scratchDir, startDaemon } from './test/control-harness.mjs';

const TMP = await scratchDir();
const HOME = path.join(TMP, 'home');
const DATA_HOME = path.join(HOME, '.local', 'share');
const SYS = path.join(TMP, 'sys');
const FLAT = path.join(TMP, 'flat');
const CONFIG = path.join(TMP, 'config');
const BIN = path.join(TMP, 'bin');
const LOG = path.join(TMP, 'systemd-run.log');

// PATH holds only the fakes and node, so the machine's own gio and gsettings cannot answer.
await fs.mkdir(BIN, { recursive: true });
await fs.symlink(process.execPath, path.join(BIN, 'node'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-systemd-run.mjs'), path.join(BIN, 'systemd-run'));
await fs.symlink(path.join(REPO, 'scripts/test/fake-gsettings.mjs'), path.join(BIN, 'gsettings'));
Object.assign(process.env, {
  PATH: BIN,
  HOME,
  XDG_DATA_HOME: DATA_HOME,
  XDG_DATA_DIRS: `${FLAT}:${SYS}`,
  XDG_CONFIG_HOME: CONFIG,
  XDG_CONFIG_DIRS: path.join(TMP, 'etc-xdg'),
  XDG_CURRENT_DESKTOP: 'KDE',
  LANG: 'de_DE.UTF-8',
  FAKE_SYSTEMD_RUN_LOG: LOG,
});
delete process.env.LC_ALL;
delete process.env.LC_MESSAGES;

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
const entry = (fields) => `[Desktop Entry]\nType=Application\nExec=true\n${fields}\n`;
const png = (size, colour) => sharp({ create: { width: size, height: size, channels: 4, background: colour } }).png().toBuffer();

// --- Desktop entries ---
const SYS_APPS = path.join(SYS, 'applications');
await write(path.join(SYS_APPS, 'gimp.desktop'), entry('Name=GIMP\nIcon=gimp'));
await write(path.join(SYS_APPS, 'shadowed.desktop'), entry('Name=System copy\nIcon=gimp'));
await write(path.join(SYS_APPS, 'gone.desktop'), entry('Name=Gone'));
await write(path.join(SYS_APPS, 'nodisplay.desktop'), entry('Name=Not in menus\nNoDisplay=true'));
await write(path.join(SYS_APPS, 'gnomeonly.desktop'), entry('Name=GNOME only\nOnlyShowIn=GNOME;'));
await write(path.join(SYS_APPS, 'notkde.desktop'), entry('Name=Not on KDE\nNotShowIn=KDE;XFCE;'));
await write(path.join(SYS_APPS, 'tryexec.desktop'), entry('Name=Not installed\nTryExec=no-such-program'));
await write(path.join(SYS_APPS, 'link.desktop'), '[Desktop Entry]\nType=Link\nName=A link\nURL=https://example.com\n');
await write(path.join(SYS_APPS, 'kde', 'sub.desktop'), entry('Name=In a subdirectory\nIcon=parentonly'));
await write(path.join(SYS_APPS, 'absolute.desktop'), entry(`Name=Absolute icon\nIcon=${path.join(TMP, 'abs.png')}`));
await write(path.join(SYS_APPS, 'pixmap.desktop'), entry('Name=Pixmap icon\nIcon=pixonly'));
await write(path.join(SYS_APPS, 'noicon.desktop'), entry('Name=No icon'));
await write(path.join(SYS_APPS, 'unfound.desktop'), entry('Name=Icon nowhere\nIcon=no-such-icon'));
await write(path.join(SYS_APPS, 'localised.desktop'), entry('Name=Hello\nName[de]=Hallo'));
await write(path.join(SYS_APPS, 'hicolor.desktop'), entry('Name=Hicolor only\nIcon=hicoloronly'));
// The user's copies: one shadows the system's, one hides it.
await write(path.join(DATA_HOME, 'applications', 'shadowed.desktop'), entry('Name=User copy\nIcon=gimp'));
await write(path.join(DATA_HOME, 'applications', 'gone.desktop'), entry('Name=Gone\nHidden=true'));
// A Flatpak export: a symbolic link into the app's own tree.
await write(path.join(TMP, 'flatpak-app', 'org.example.Flat.desktop'), entry('Name=Flat app\nIcon=org.example.Flat'));
await fs.mkdir(path.join(FLAT, 'applications'), { recursive: true });
await fs.symlink(path.join(TMP, 'flatpak-app', 'org.example.Flat.desktop'), path.join(FLAT, 'applications', 'org.example.Flat.desktop'));

// --- Icon themes ---
const USER_ICONS = path.join(DATA_HOME, 'icons');
await write(path.join(USER_ICONS, 'Child', 'index.theme'), `[Icon Theme]
Name=Child
Inherits=Parent,hicolor
Directories=48x48/apps,scalable/apps

[48x48/apps]
Size=48
Type=Fixed

[scalable/apps]
Size=64
MinSize=16
MaxSize=512
Type=Scalable
`);
await write(path.join(USER_ICONS, 'Child', 'scalable', 'apps', 'gimp.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e33"/></svg>');
await write(path.join(USER_ICONS, 'Child', '48x48', 'apps', 'sizes.png'), await png(48, '#333'));
await write(path.join(USER_ICONS, 'Child', 'scalable', 'apps', 'sizes.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>');
// Parent inherits Child back: a loop the lookup must not follow for ever.
await write(path.join(SYS, 'icons', 'Parent', 'index.theme'), `[Icon Theme]
Name=Parent
Inherits=Child
Directories=96x96/apps

[96x96/apps]
Size=96
Type=Fixed
`);
await write(path.join(SYS, 'icons', 'Parent', '96x96', 'apps', 'parentonly.png'), await png(96, '#3a3'));
await write(path.join(SYS, 'icons', 'hicolor', 'index.theme'), `[Icon Theme]
Name=Hicolor
Directories=32x32/apps,256x256/apps

[32x32/apps]
Size=32
Type=Threshold

[256x256/apps]
Size=256
Type=Fixed
`);
await write(path.join(SYS, 'icons', 'hicolor', '32x32', 'apps', 'hicoloronly.png'), await png(32, '#33a'));
await write(path.join(SYS, 'icons', 'hicolor', '256x256', 'apps', 'hicoloronly.png'), await png(256, '#33a'));
await write(path.join(SYS, 'icons', 'hicolor', '32x32', 'apps', 'gimp.png'), await png(32, '#aa3'));
await write(path.join(FLAT, 'icons', 'hicolor', '256x256', 'apps', 'org.example.Flat.png'), await png(256, '#a3a'));
await write(path.join(SYS, 'pixmaps', 'pixonly.png'), await png(64, '#3aa'));
await write(path.join(TMP, 'abs.png'), await png(64, '#999'));
// KDE's theme, from the look-and-feel defaults: the user's kdeglobals says nothing.
await write(path.join(CONFIG, 'kdedefaults', 'kdeglobals'), '[General]\nfoo=bar\n\n[Icons]\nTheme=Child\n');
await write(path.join(CONFIG, 'kdeglobals'), '[General]\nfoo=bar\n');

const apps = await import(path.join(REPO, 'dist/services/apps.js'));
const icons = await import(path.join(REPO, 'dist/services/icon-theme.js'));
const { runAction } = await import(path.join(REPO, 'dist/actions/index.js'));
const { defaultIconFor } = await import(path.join(REPO, 'dist/default-icons.js'));

console.log('desktop entries');
const listed = await apps.listApps();
const ids = listed.map((a) => a.id).sort();
check('the menu list is what a menu would show', JSON.stringify(ids) === JSON.stringify([
  'absolute.desktop', 'gimp.desktop', 'hicolor.desktop', 'kde-sub.desktop', 'localised.desktop', 'noicon.desktop',
  'org.example.Flat.desktop', 'pixmap.desktop', 'shadowed.desktop', 'unfound.desktop',
]));
const byId = (id) => listed.find((a) => a.id === id);
check("the user's copy shadows the system's", byId('shadowed.desktop')?.name === 'User copy');
check('a user copy with Hidden=true removes the app', !ids.includes('gone.desktop') && (await apps.findApp('gone.desktop')) === null);
check('a subdirectory joins the ID with a dash', byId('kde-sub.desktop')?.name === 'In a subdirectory');
check("a Flatpak export's symbolic link is followed", byId('org.example.Flat.desktop')?.name === 'Flat app');
check('the name is localised: Name[de] under LANG=de_DE', byId('localised.desktop')?.name === 'Hallo');
check('listed by name', listed.map((a) => a.name).join('|') === [...listed.map((a) => a.name)].sort((a, b) => a.localeCompare(b)).join('|'));
check('NoDisplay is not listed, but a key can still name it', !ids.includes('nodisplay.desktop') && (await apps.findApp('nodisplay.desktop'))?.name === 'Not in menus');
check('an unknown ID is not found', (await apps.findApp('no-such-app.desktop')) === null);
check('a Link entry is not an application', (await apps.findApp('link.desktop')) === null);

console.log('icon theme');
check("KDE's theme comes from kdedefaults when the user's kdeglobals names none", (await icons.currentIconTheme()) === 'Child');
const at = (...parts) => path.join(...parts);
check('the theme wins over hicolor', (await icons.resolveIcon('gimp', 96)) === at(USER_ICONS, 'Child/scalable/apps/gimp.svg'));
check('an exact size is taken first', (await icons.resolveIcon('sizes', 48)) === at(USER_ICONS, 'Child/48x48/apps/sizes.png'));
check('...and a scalable one when none is exact', (await icons.resolveIcon('sizes', 96)) === at(USER_ICONS, 'Child/scalable/apps/sizes.svg'));
check('an inherited theme is searched, past a loop', (await icons.resolveIcon('parentonly', 96)) === at(SYS, 'icons/Parent/96x96/apps/parentonly.png'));
check('hicolor last: the larger bitmap, not the closer smaller one', (await icons.resolveIcon('hicoloronly', 96)) === at(SYS, 'icons/hicolor/256x256/apps/hicoloronly.png'));
check("a Flatpak's hicolor, from its XDG_DATA_DIRS entry", (await icons.resolveIcon('org.example.Flat', 96)) === at(FLAT, 'icons/hicolor/256x256/apps/org.example.Flat.png'));
check('unthemed pixmaps last of all', (await icons.resolveIcon('pixonly', 96)) === at(SYS, 'pixmaps/pixonly.png'));
check('an absolute path is used as it is', (await icons.resolveIcon(at(TMP, 'abs.png'), 96)) === at(TMP, 'abs.png'));
check('a name with an extension is looked up without it', (await icons.resolveIcon('gimp.png', 96)) === at(USER_ICONS, 'Child/scalable/apps/gimp.svg'));
check('an icon found nowhere is null', (await icons.resolveIcon('no-such-icon', 96)) === null);

await write(path.join(CONFIG, 'kdeglobals'), '[Icons]\nTheme=Parent\n');
check('an answer is cached until forgotten', (await icons.currentIconTheme()) === 'Child');
apps.forgetApps();
check("the user's kdeglobals wins over kdedefaults", (await icons.currentIconTheme()) === 'Parent');
process.env.XDG_CURRENT_DESKTOP = 'GNOME';
process.env.FAKE_ICON_THEME = 'Child';
apps.forgetApps();
check("elsewhere, GNOME's icon-theme setting", (await icons.currentIconTheme()) === 'Child');
delete process.env.FAKE_ICON_THEME;
apps.forgetApps();
check('...and hicolor with no setting at all', (await icons.currentIconTheme()) === 'hicolor');
process.env.XDG_CURRENT_DESKTOP = 'KDE';
await write(path.join(CONFIG, 'kdeglobals'), '[General]\nfoo=bar\n');
apps.forgetApps();

console.log('launching');
const ctx = { log: () => undefined };
const launches = async (expected) => {
  for (let i = 0; i < 100; i++) {
    const lines = (await fs.readFile(LOG, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (lines.length >= expected) return lines;
    await new Promise((r) => setTimeout(r, 20));
  }
  return [];
};
let failure = await runAction(ctx, { type: 'app', app: 'gimp.desktop' });
check('no gio: the press fails and says so', /gio is not installed/.test(failure ?? ''));
await fs.symlink(path.join(REPO, 'scripts/test/fake-gio.mjs'), path.join(BIN, 'gio'));
process.env.FAKE_GIO_OLD = '1';
failure = await runAction(ctx, { type: 'app', app: 'gimp.desktop' });
check('a gio with no "gio launch" (GLib before 2.72): fails, naming the version', /GLib 2\.72/.test(failure ?? ''));
delete process.env.FAKE_GIO_OLD;
failure = await runAction(ctx, { type: 'app', app: 'shadowed.desktop' });
const runs = await launches(1);
check('the press returns, not failed', failure === null);
check('gio launch is given the winning entry, through systemd-run --user --scope', JSON.stringify(runs[0]) === JSON.stringify(
  ['--user', '--scope', '--quiet', '--collect', '--', 'gio', 'launch', path.join(DATA_HOME, 'applications', 'shadowed.desktop')],
));
check('an app not installed fails the press', /no installed application "no-such-app.desktop"/.test((await runAction(ctx, { type: 'app', app: 'no-such-app.desktop' })) ?? ''));
check('a hidden app fails the press', (await runAction(ctx, { type: 'app', app: 'gone.desktop' })) !== null);
check('no "app" fails the press', /needs "app"/.test((await runAction(ctx, { type: 'app' })) ?? ''));
check('nothing else was launched', (await launches(1)).length === 1);

console.log('the default icon, on a deck');
const SERIAL = 'APPS-XL';
const hotkey = { type: 'hotkey', keys: 'f1' };
const button = (action, extra = {}) => ({ action, ...extra });
const deckConfig = {
  profiles: {
    default: {
      name: 'Default',
      layouts: {
        [SERIAL]: {
          startPage: 'main',
          pages: {
            main: {
              name: 'Main',
              buttons: {
                0: button({ type: 'app', app: 'gimp.desktop' }),
                1: button(hotkey, { icon: at(USER_ICONS, 'Child/scalable/apps/gimp.svg') }),
                2: button({ type: 'app', app: 'noicon.desktop' }),
                3: button({ type: 'app', app: 'unfound.desktop' }),
                4: button({ type: 'app', app: 'no-such-app.desktop' }),
                5: button(hotkey, { icon: 'builtin:command' }),
                6: button({ type: 'app', app: 'gimp.desktop' }, { icon: at(TMP, 'abs.png') }),
                7: button(hotkey, { icon: at(TMP, 'abs.png') }),
                8: button({ type: 'app', app: 'gimp.desktop' }, { icon: null }),
                9: button(hotkey, { icon: null }),
              },
            },
          },
        },
      },
    },
  },
};
const daemon = await startDaemon(TMP, deckConfig);
const deck = new FakeDeck();
await daemon.attach(SERIAL, deck);
const same = (a, b) => deck.images.get(a)?.equals(deck.images.get(b)) === true;
check("an app key with no icon draws the app's icon", same(0, 1));
check('an app with no Icon= draws the built-in default', defaultIconFor({ type: 'app' }) === 'command' && same(2, 5));
check('...as does one whose icon is found nowhere', same(3, 5));
check('...and one not installed', same(4, 5));
check("the key's own icon wins over the app's", same(6, 7) && !same(6, 0));
check('icon: null stays blank', same(8, 9) && !same(8, 0));
check('the comparison can fail', !same(0, 5));
check('the resolved icon is not written to the config', !('icon' in daemon.state.config.profiles.default.layouts[SERIAL].pages.main.buttons['0']));

console.log('the apps command');
{
  const client = await connect(daemon.socket);
  const reply = await client.request('apps');
  const gimp = reply.result?.find((a) => a.id === 'gimp.desktop');
  check('lists the apps, each with id, name and resolved icon', reply.ok === true && reply.result.length === 10 && gimp?.name === 'GIMP' && gimp.icon === at(USER_ICONS, 'Child/scalable/apps/gimp.svg'));
  check('an icon found nowhere is null', reply.result?.find((a) => a.id === 'unfound.desktop')?.icon === null);
  // A new app and a changed theme, then the command again: it reads afresh.
  await write(path.join(SYS_APPS, 'new.desktop'), entry('Name=Newly installed\nIcon=parentonly'));
  await write(path.join(CONFIG, 'kdeglobals'), '[Icons]\nTheme=hicolor\n');
  const again = await client.request('apps');
  check('asking again finds a newly installed app', again.result?.some((a) => a.id === 'new.desktop') === true);
  check("...and the changed theme: GIMP's icon now comes from hicolor", again.result?.find((a) => a.id === 'gimp.desktop')?.icon === at(SYS, 'icons/hicolor/32x32/apps/gimp.png'));
  client.close();
}

await daemon.stop();
await fs.rm(TMP, { recursive: true, force: true });
console.log(failureCount() === 0 ? '\napps: all checks passed' : `\napps: ${failureCount()} check(s) failed`);
process.exit(failureCount() === 0 ? 0 : 1);
