# AGENTS.md

Deckhand is a Linux daemon that drives Elgato Stream Decks and touchscreens
used as "virtual decks", with an Electron editor and two small C helpers: the
input helper (`helper/`) and the display helper (`panel/`).

Read ARCHITECTURE.md (how it fits together, and its invariants table),
SECURITY.md (what is in scope) and REFERENCE.md (behaviour; its "Developing"
section covers the checks and their traps) before reviewing.

## Deliberate design — not defects
- Keystrokes are injected through a uinput virtual keyboard
  (`helper/deckhand-input.c`), not a desktop portal. `udev/60-deckhand.rules`
  gives the logged-in user the decks and `/dev/uinput` through the uaccess
  tag, so any of that user's programs can type once it is installed; SECURITY.md
  puts that out of scope.
- No timers at rest beyond the three recurring ones ARCHITECTURE.md accepts:
  the 60-second device scan, the 500 ms render tick per deck, and the hourly
  Twitch check while an account is linked. They are the only `setInterval`
  calls in `src/`. The rest of the daemon runs on events and one-shot
  deadlines, and ARCHITECTURE.md lists the polling it allows while someone
  is linking a Twitch account. Any other polling loop or recurring timer in
  the daemon is a defect.
- Integrations, not plugins. There is no plugin system: each integration is a
  client of its service's own API or socket, and the daemon loads no
  third-party code at run time beyond its own packaged dependencies.
- Touchscreen access: a root-owned helper (`udev/deckhand-touch-access`, which
  the editor runs through pkexec) writes one udev rule file per user, with one
  entry per paired touchscreen, granting that user a read-only ACL. A
  touchscreen is never given a rule covering every touchscreen, or the uaccess
  tag. A touchscreen with no serial number is matched by model, so identical
  ones share an entry. While pairing, the user briefly has read access to every
  touchscreen they cannot already read, so the daemon can see which is tapped;
  this is dropped on every path, after 5 minutes at most.
- No touch on a virtual deck acts while the session is locked or inactive;
  failing to read the lock state fails closed. This covers touch only:
  Stream Deck keys are not gated on the lock state.
- Credentials live in an owner-only (0600) file in the state directory
  (`~/.local/state/deckhand/credentials.json`), never in `config.json`, an
  export or a backup.
- The editor's pickers for OBS, VTube Studio, Discord, Twitch categories and
  audio devices come only from the live service or device list, with no typed
  fallback. The editor stores an audio device as node + label, and the node is
  matched exactly. The substring `match` parameter on `audio.sink` exists for
  hand-edited config only: the editor never writes it and it is ignored when
  `node` is set.

## Review guidelines
Prioritise, in order:
1. Privilege and input boundaries: the pkexec helper and its arguments, udev
   rule writing, the control socket (`src/control/`: permissions and every
   command's input), the input helper.
2. Untrusted input: imported bundles (a zip, or a bare config file:
   `editor/src/main/import-bundle.ts`), config files, data from OBS, VTube
   Studio, Twitch and Discord, and evdev frames in the display helper
   (`panel/evdev.c`). The input helper reads no evdev, only commands on stdin.
3. Secrets: tokens or passwords reaching logs, exports, error messages or the
   editor.
4. Resource use: anything that adds work at rest, leaks per redraw, or blocks
   the daemon's event loop.
5. Correctness of state shown on keys versus the real service state.

Style, naming and formatting are low priority unless they hide a bug. Report
findings with a concrete failure scenario; do not report the deliberate choices
above.

## Checks
Run the offline suites before suggesting a change is safe, and judge each by
its exit code, not the tail of its output. There is no `npm test` at the root.

- Daemon, at the root: `npm ci`, then `npm run typecheck`, `npm run build` and
  `npm run smoke`. Without `kwin_wayland` or a built helper, `smoke-panel`
  prints "skipped" and passes.
- Editor, in `editor/`: `npm ci`, then `npm run typecheck`, `npm test`, and the
  `npm run check:*` scripts, which REFERENCE.md lists. They run real Electron
  against the daemon in the root `dist/`, so build the root first.
- Installer: `bash scripts/test/<name>.test.sh`, for each of those files.
