import { Menu, Tray, nativeImage } from 'electron';

/**
 * The tray icon: a launcher, not a status indicator.
 * A left-click opens the editor; the menu offers Open and Quit.
 *
 * **A single click, not a double-click.** Electron's
 * `'double-click'` is macOS and Windows only; on Linux the one click event is
 * `'click'`, sent by a KDE panel on a single left-click. Emulating a double
 * click from two of them was rejected — it would make a single click wait to
 * see whether a second one comes.
 *
 * Two platform facts: nativeImage takes PNG
 * and JPEG only, so the icon is a PNG rendered from the logo
 * (scripts/render-logo-png.mjs); and nothing can say whether the icon is
 * actually visible — constructing it means it registered, not that a panel
 * shows it.
 */
export interface LauncherTray {
  /** Whether there is a tray icon to come back from. */
  alive(): boolean;
  /** For checks: the handlers a click and each menu item run, in menu order. */
  handlers(): { click: () => void; menu: Array<{ label: string; click: () => void }> };
  destroy(): void;
}

export function createTray({ iconPath, open, quit }: { iconPath: string; open: () => void; quit: () => void }): LauncherTray {
  // A missing file gives an empty image rather than an error, and a Tray
  // built from one fails later with a less useful message.
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    console.error(`[tray] no icon at ${iconPath}; there will be no tray, and closing the window quits`);
    return deadTray();
  }
  let tray: Tray;
  try {
    tray = new Tray(image);
  } catch (err) {
    console.error(`[tray] could not create the icon: ${err instanceof Error ? err.message : String(err)}; closing the window quits`);
    return deadTray();
  }
  const menu = [
    { label: 'Open Deckhand', click: open },
    { label: 'Quit Deckhand', click: quit },
  ];
  tray.setToolTip('Deckhand');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: menu[0].label, click: () => menu[0].click() },
      { type: 'separator' },
      { label: menu[1].label, click: () => menu[1].click() },
    ]),
  );
  tray.on('click', () => open());
  return {
    alive: () => !tray.isDestroyed(),
    handlers: () => ({ click: () => tray.emit('click'), menu }),
    destroy: () => {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}

/** No tray: what createTray returns when there cannot be one, so callers never check for null. */
export function deadTray(): LauncherTray {
  return {
    alive: () => false,
    handlers: () => ({ click: () => undefined, menu: [] }),
    destroy: () => undefined,
  };
}
