// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';
import {
	createFileExclusive,
	isPidAlive,
	parsePidRecord,
	pidCommand,
	reapDevPidfile,
	releaseDevPidfile,
} from './dev-pidfile.js';

/**
 * The lock of the steps that write shared files of a checkout while an app is
 * synthesized. For internal use only.
 *
 * A deploy synthesizes into a cloud assembly directory of its own, so the CDK
 * CLI's lock on a shared `cdk.out` no longer keeps two synths of one checkout
 * apart. But a synth, and the client generation before it, still write files
 * that every command of the checkout shares: `cdk-blocks/client.js`, the
 * frontend build output with the backend URL built in, and Hosting's `.hosting`
 * staging directory, which is replaced as a whole. Two commands that overlap
 * there (a deploy with one profile and one with another) can stage each
 * other's frontend into their own assembly.
 *
 * The lock is a file in the project's {@link BLOCKS_SANDBOX_DIR}, created
 * exclusively, with the holder's pid, its command line and the command the user
 * ran. It is held from before the client is generated until the synth has
 * exited: the assembly then holds its own copy of every asset, so the deploy of
 * that assembly runs without it. A second command does not wait: it stops
 * before it generates or builds anything, as the CDK CLI refused a second synth
 * into the same directory.
 *
 * The file is a pidfile of the dev server's kind (see `dev-pidfile.ts`), and is
 * created, read, taken over and removed with its helpers: a lock whose process
 * is gone, or whose pid now belongs to another command line, is stale and is
 * taken over, and only the record that was inspected is ever removed.
 */

/** The lock file, relative to the project root. */
export const SYNTH_LOCK_FILE = `${BLOCKS_SANDBOX_DIR}/synth.pid`;

/** How often a claimant looks again when the lock changed hands while it was looking. */
const CLAIM_ATTEMPTS = 5;

/** A held {@link acquireSynthLock | synth lock}. */
export interface SynthLock {
	/** Remove the lock, if this process still holds it. Safe to call more than once. */
	release(): void;
}

/** Test seams for {@link acquireSynthLock}; the defaults are the real process table. */
export interface SynthLockDeps {
	isAlive?: (pid: number) => boolean;
	commandOf?: (pid: number) => string;
}

/**
 * Take the synth lock of the app at `projectRoot` for `invocation`, the command
 * the user ran (`npm run deploy`).
 *
 * The lock is also released when the process exits (a `process.exit` of a
 * signal handler, an uncaught error). A process that a signal kills outright
 * leaves the file behind with a dead pid, which the next command takes over.
 *
 * @throws {Error} When another live command of this app holds the lock, naming
 * its pid and command; or when the lock file can't be read or replaced.
 */
export function acquireSynthLock(projectRoot: string, invocation: string, deps: SynthLockDeps = {}): SynthLock {
	const isAlive = deps.isAlive ?? ((pid: number) => isPidAlive(pid));
	const commandOf = deps.commandOf ?? pidCommand;
	const path = join(projectRoot, SYNTH_LOCK_FILE);
	mkdirSync(join(projectRoot, BLOCKS_SANDBOX_DIR), { recursive: true });
	const body = JSON.stringify({
		pid: process.pid,
		ppid: process.ppid,
		// A pidfile record has a port; this one guards none.
		port: 0,
		command: commandOf(process.pid),
		token: randomUUID(),
		invocation,
	});
	for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
		if (createFileExclusive(path, body)) {
			let released = false;
			const release = (): void => {
				if (released) return;
				released = true;
				process.removeListener('exit', release);
				releaseDevPidfile(path, process.pid);
			};
			process.once('exit', release);
			return { release };
		}
		let held: string;
		try {
			held = readFileSync(path, 'utf-8');
		} catch {
			continue; // released between the create and the read
		}
		const holder = parsePidRecord(held);
		// A pid the OS has reused for another command is not the holder (see DevServerPidRecord.command).
		if (holder && isAlive(holder.pid) && (holder.command === undefined || commandOf(holder.pid) === holder.command)) {
			throw new Error(
				`${holderInvocation(held)} (pid ${holder.pid}) is generating the client and synthesizing this app, and \`${invocation}\` ` +
					`would write the same files (cdk-blocks/client.js, the frontend build, .hosting). Nothing was generated or built. ` +
					`Wait for it to finish its synth, then re-run \`${invocation}\`.`,
			);
		}
		// Stale, or not a record: remove exactly what was read, never a lock taken since.
		reapDevPidfile(path, held);
	}
	throw new Error(
		`Could not take the synth lock ${SYNTH_LOCK_FILE} for \`${invocation}\`: it changed every time it was read. ` +
			`If no other command of this app is running, delete the file and re-run \`${invocation}\`.`,
	);
}

/** How the holder of the lock body `held` was run, for the message; a generic name for a body without it. */
function holderInvocation(held: string): string {
	try {
		const parsed: unknown = JSON.parse(held);
		if (parsed && typeof parsed === 'object' && 'invocation' in parsed && typeof parsed.invocation === 'string') {
			return `\`${parsed.invocation}\``;
		}
	} catch {
		// Not JSON: the generic name.
	}
	return 'Another command';
}
