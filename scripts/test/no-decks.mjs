/**
 * Given to a child with `--import`, this registers the hooks in
 * scripts/test/no-decks-hooks.mjs, so the child sees no Stream Decks no
 * matter what is plugged into the machine. Two files because the hooks run on
 * their own thread and are loaded by specifier.
 */
import { register } from 'node:module';

register('./no-decks-hooks.mjs', import.meta.url);
