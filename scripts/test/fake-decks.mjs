/**
 * Given to a child with `--import`, this registers the hooks in
 * scripts/test/fake-decks-hooks.mjs, so the child sees the fake decks in
 * `FAKE_DECKS_FILE` instead of whatever is plugged into the machine, and
 * rescans on SIGUSR2. Two files because the hooks run on their own thread and
 * are loaded by specifier.
 */
import { register } from 'node:module';

register('./fake-decks-hooks.mjs', import.meta.url);
