/**
 * A failed press whose message tells the person what to do: "Hold for 1
 * second to stop the stream", "OBS is not running…", "Nothing is recording…".
 * Every failure badges its key; only these are also shown as a desktop
 * notification (services/notifications.ts), because only these are worth
 * interrupting someone for — the text is the fix. Plain Error for the rest.
 */
export class ActionNeeded extends Error {}
