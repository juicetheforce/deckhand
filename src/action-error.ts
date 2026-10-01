/**
 * A failed press whose message tells the person what to do: "Hold for 1
 * second to stop the stream", "OBS is not running…", "Nothing is recording…".
 * Every failure badges its key; only these are also shown as a desktop
 * notification (services/notifications.ts), because only these are worth
 * interrupting someone for — the text is the fix. Plain Error for the rest.
 */
export class ActionNeeded extends Error {}

/**
 * A press of a key for an integration that is not set up (OBS with no saved
 * connection). Not a failure of the key: its face already says so (drawn
 * dimmed, with the not-set-up badge), so it is never marked — a mark would
 * outlast the setup, and only a press that works clears one. Notified once,
 * daemon-wide, until the setup changes.
 */
export class NotSetUp extends ActionNeeded {}
