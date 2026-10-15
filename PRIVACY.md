# Privacy

Deckhand sends nothing to its developers. There is no telemetry, no crash
reporting and no account with Deckhand.

## What leaves your computer

Only what you set up, and only to the service you set it up for:

- **Twitch**, if you link a Twitch account. Deckhand talks to Twitch at
  `id.twitch.tv` and `api.twitch.tv`:
  - while you link, to ask for a code and to ask whether you have approved
    it;
  - once an hour while an account is linked, to check and renew the link,
    as Twitch requires;
  - when you press a Twitch key, to do what the key does: add a stream
    marker, make a clip, send a chat message, or change your title and
    category;
  - while you search for a category in the editor;
  - when you remove the link, to end it.

  What it sends is what that request needs: the tokens Twitch gave it, your
  Twitch user ID, and the key's own text (a marker's description, a clip's
  title, a chat message, a title, a category). Twitch's own privacy notice
  covers what Twitch does with it.
- **Album art.** When a media player shares a picture's web address for the
  track that is playing, Deckhand downloads it to show on a key.
- **The update check.** Each time the editor opens, it asks GitHub
  (`api.github.com`) for the newest release of Deckhand, so that **Settings ›
  About** can say when one is out. The request carries nothing about you or
  your setup — not even which version you have, which is compared on your
  computer — and GitHub sees the address it comes from, as for any request.
  Nothing is downloaded or installed. Turn it off with **Check for updates**
  in Settings › About; the daemon never makes this request.

OBS Studio and VTube Studio are reached on your own computer or network,
not the internet.

## What is kept, and where

- **The Twitch link**: the tokens, your Twitch user ID and login name, and
  what the link allows, in `~/.local/state/deckhand/credentials.json`,
  readable only by you, with the OBS password and VTube Studio's token.
  They are never in Deckhand's configuration, its exports or its backups.
- **Your configuration**, in `~/.config/deckhand/config.json`. For a Stream
  info key it holds the category's ID and name as you chose them.

Nothing from Twitch is kept beyond that: Deckhand shows nothing from Twitch
on its keys, so it stores nothing it reads from Twitch.

## Ending it

**Remove** in the editor's **Settings › Integrations › Twitch** deletes the
link from your computer and ends it at Twitch. You can also end it at
twitch.tv/settings/connections, where Twitch lists it as "DeckHandApp";
Deckhand then stops using it, and Remove deletes what is left.
Uninstalling Deckhand with `deckhand-uninstall` ends the link at Twitch
first, then deletes that file with the rest of Deckhand's state. If Twitch
does not confirm — no internet, say, or Deckhand's service not running — the
uninstaller says so: end it at twitch.tv/settings/connections. A link nothing
uses any more lapses after 30 days anyway.

## Questions

Ask in an issue on GitHub, or privately through the repository's
**Security** tab.
