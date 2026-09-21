#!/usr/bin/env node
/**
 * A stand-in for systemd-run, for offline tests: put its directory first on
 * PATH under the name "systemd-run". It starts nothing; it appends its
 * arguments, as one JSON array per line, to the file named by
 * FAKE_SYSTEMD_RUN_LOG, so a test can see exactly what would have been
 * launched and how.
 */
import { appendFileSync } from 'node:fs';

const log = process.env.FAKE_SYSTEMD_RUN_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
