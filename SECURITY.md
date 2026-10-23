# Security

Deckhand synthesises keystrokes through a virtual keyboard and installs a udev
rule to do it, so a flaw in it can matter beyond Deckhand itself. Please
report one privately.

## Reporting

Use GitHub's private vulnerability reporting: the repository's **Security**
tab, then **Report a vulnerability**. Please don't open a public issue for a
security problem.

This is a one-person project. I'll acknowledge a report as soon as I can,
usually within a few days. Only the latest release is supported.

## What is in scope

- **The input helper** (`helper/deckhand-input.c`) and the daemon's use of it:
  anything that lets another process make it type, or leaves a key held down.
- **The control socket** (`$XDG_RUNTIME_DIR/deckhand.sock`, mode `0600`):
  anything that lets another user reach it, or a client make the daemon do
  more than its commands allow.
- **The udev rule** (`/etc/udev/rules.d/60-deckhand.rules`), which gives the
  logged-in user access to the decks and to `/dev/uinput`, and the rules
  for paired touchscreens (below). Its breadth is deliberate — any process
  of that user can then
  synthesise keystrokes, which is why uninstalling always removes it — but a
  way to widen it further is in scope.
- **Virtual decks**: anything that lets a touch run an action while the
  session is locked or not the active one; that gives access to a
  touchscreen that was not paired, or keeps the temporary access after
  pairing ends; that makes the root pairing helper do anything but write
  its own rule file and set access on touchscreens; or that leaves a
  touchscreen grabbed after Deckhand lets go of it.
- **The install script** (`scripts/install.sh`), which runs `sudo` for the
  udev rule and, on some distributions, an AppArmor profile for the editor.
- **Config import** in the editor, which writes icon files from an archive:
  anything that writes outside the places it shows you before importing.
- **The secrets** Deckhand keeps, the OBS password, VTube Studio's token,
  and Twitch's and Discord's tokens: anything that puts one anywhere but its
  own file, or lets another user read it.
- **Twitch**: anything that sends a Twitch token anywhere but `id.twitch.tv`
  and `api.twitch.tv`, or makes Deckhand act on Twitch without a key press,
  beyond the hourly check Twitch requires and linking you started.
- **Discord**: anything that sends a Discord token anywhere but `discord.com`
  and the Discord app's own local socket, or makes Deckhand change your
  voice settings or channel without a key press.

## Device access

The udev rule Deckhand installs uses `uaccess`: access goes to the user at
the active local session, and is taken back on a user switch. It covers
Stream Decks (by Elgato's USB vendor) and `/dev/uinput`, which lets any
program you run type as you.

**It covers no touchscreen.** Wayland keeps programs from reading each other's
input: normally only your desktop sees a touchscreen's touches. A rule that
gives you access to a touchscreen opts that device out of the protection, so
any program running as you could read its touches — on a touchscreen laptop,
including what you type on its on-screen keyboard. So Deckhand gives access
**only to touchscreens you pair as virtual decks, never to any other, and
only from the moment you pair them**:

- Pairing a touchscreen in Settings › Decks asks for your password once. A
  small helper, `/usr/local/libexec/deckhand-touch-access`, installed
  root-owned, then gives you temporary read access to the connected
  touchscreens, so Deckhand can see which one you tap; writes a rule for that
  one touchscreen alone, by its vendor and product IDs and its serial number
  when it has one, to `/etc/udev/rules.d/61-deckhand-touchscreens-<your user
  ID>.rules`; and takes the temporary access away. It is taken away too if
  you cancel, if nothing is tapped, if the editor closes, and after 5
  minutes at most.
- **The access belongs to you, the user who paired the touchscreen, not to
  whoever is logged in.** The rule gives your user read access by a file ACL
  each time the touchscreen appears. Unlike the Stream Decks', it is not
  handed to the person at the seat: if someone else logs in on the same
  computer, they cannot read it, and your programs still can, even while
  their session is the active one. Read access only: nothing can write to it.
- Why not `uaccess`, as for the decks: udev keeps that tag on a device until
  it is unplugged or the computer restarts, and gives the access back every
  time the device's rules are re-applied — which other software does too. A
  touchscreen granted that way could not be taken back on Remove. A file ACL
  is gone once removed.
- A touchscreen with no serial number is covered by its model: an identical
  touchscreen plugged in later is covered too.
- Removing a virtual deck removes its touchscreen's entry and its ACL at
  once, and asks for your password to do it. Uninstalling removes every
  user's entries and the helper, and takes your access off each touchscreen
  at once; another user's paired access lasts until the computer restarts.

Deckhand grabs the paired touchscreen, so the desktop sees none of its
touches. Reading the device directly bypasses the lock screen, so **touches
do nothing while the session is locked or not the active one**, as logind
reports it, and nothing while Deckhand cannot tell.

## Secrets

Deckhand keeps four kinds of secret: the password for OBS's WebSocket
server, the token VTube Studio gives Deckhand when you allow it, the tokens
Twitch gives Deckhand when you link your account, and the tokens Discord
gives your own Discord application when you authorize it. All are kept the
same way.

- They live in `~/.local/state/deckhand/credentials.json` (under
  `$XDG_STATE_HOME` if set), mode `0600`, written by temporary file and
  rename so the file is never on disk with wider permissions. It is outside
  the config directory, which people sync or keep in dotfiles.
- They are **never in `config.json`, an export or a backup**. Exports bundle
  the config and its icons; the rolling backups copy the config. Neither
  touches this file, so restoring an export or a backup never restores a
  secret.
- The daemon writes the file. The OBS password reaches it from the editor
  over the control socket (mode `0600`), or from `deckhand obs password`,
  which reads it from the terminal or stdin, never from an argument, which
  every process could see. VTube Studio's token comes from VTube Studio
  itself, when you allow Deckhand in its window, Twitch's from Twitch,
  when you approve Deckhand at twitch.tv/activate, and Discord's from
  Discord, when you choose Authorize in the Discord app's window. **The socket never
  returns any of them**, only whether one is set.
- They are not encrypted at rest, and not kept in the desktop keyring: the
  keyring would not separate them from your other programs either, and the
  udev rule above already trusts them. Full-disk encryption is what protects
  them at rest.

OBS's WebSocket server listens on every network interface, with no option to
listen on this computer alone, so its password is all that stands between
your network and OBS. Use a strong one: OBS's default is a generated
16-character password, and **Show Connect Info** has it.

VTube Studio's API listens on every IPv4 network interface too, and a
plugin's token is all that stands between your network and it. VTube Studio
asks you before giving a plugin one, and anything that can reach its port
can make that window appear, so allow only a request you made, from
Deckhand's **Connect**. Removing a plugin in VTube Studio's plugin list
revokes its token.

## Twitch

Twitch's tokens are different from the other two: they are for a service on
the internet, not one on your computer or network, and **a stolen one works
from anywhere**. Anything that can read the credentials file can act as you
on Twitch, within what the link allows (your title, category and markers;
clips; chat messages), until the link is ended. End it with **Remove** in
Deckhand's Settings, which revokes it at Twitch, or at
twitch.tv/settings/connections, where Twitch lists it as "Deckhand App".
Changing your Twitch password ends it too.

Deckhand talks to Twitch only at `id.twitch.tv` and `api.twitch.tv`, over
HTTPS: when a key is pressed, once an hour while an account is linked
(Twitch requires apps to check their link that often), and every few
seconds while a linking code waits to be approved. It is a public client:
no secret ships with it, and none is needed. Who it sends what to is in
[PRIVACY.md](PRIVACY.md).

## Discord

Discord's tokens let a program control your voice through the Discord app:
mute and deafen you, change your input mode, move you between voice
channels, and change how loud you hear people. Anything that can read the
credentials file can do that, until the authorization is revoked. Whether a
stolen token works with a Discord app on another computer has not been
tested; treat it as if it does. Revoke it with **Remove** in Deckhand's
Settings, or in Discord's **User Settings › Authorized Apps**.

The application is your own, made in Discord's Developer Portal, as a
public client: there is no client secret, in Deckhand or anywhere else.
Deckhand talks to Discord's servers only at `discord.com`, over HTTPS, to
authorize, renew and revoke ([PRIVACY.md](PRIVACY.md)); everything else goes
to the Discord app on your computer, over its local socket.

Out of scope: that a user's own processes can use `/dev/uinput` once the rule
is installed (that is what it is for), and anything that needs root already.
