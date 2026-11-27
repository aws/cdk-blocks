// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { acquireSynthLock, SYNTH_LOCK_FILE } from './synth-lock.js';

// Two commands of one checkout that generate the client and synthesize at the
// same time write the same files (cdk-blocks/client.js, the frontend build,
// Hosting's .hosting staging). The second one must stop before it writes any.
describe('acquireSynthLock', () => {
	let root: string;
	let lockFile: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'blocks-synth-lock-'));
		lockFile = join(root, SYNTH_LOCK_FILE);
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** The lock of another process `pid`, as that process wrote it. */
	function heldBy(pid: number, command: string, invocation = 'npm run deploy'): void {
		mkdirSync(join(root, '.cdk-blocks-sandbox'), { recursive: true });
		writeFileSync(lockFile, JSON.stringify({ pid, ppid: 1, port: 0, command, token: `token-${pid}`, invocation }));
	}
	/** A process table in which `pids` run, each with the command line `node deploy`. */
	const running = (...pids: number[]) => ({
		isAlive: (pid: number) => pid === process.pid || pids.includes(pid),
		commandOf: (pid: number) => (pid === process.pid ? 'node this-test' : 'node deploy'),
	});

	it('creates the lock with the pid and the command of its holder, and removes it on release', () => {
		const lock = acquireSynthLock(root, 'npm run deploy -- --profile dev', running());
		const record = JSON.parse(readFileSync(lockFile, 'utf-8'));
		assert.equal(record.pid, process.pid);
		assert.equal(record.command, 'node this-test');
		assert.equal(record.invocation, 'npm run deploy -- --profile dev');
		lock.release();
		assert.ok(!existsSync(lockFile));
		// Nothing else is left next to it (a temp file, a reap file).
		assert.deepEqual(readdirSync(join(root, '.cdk-blocks-sandbox')), []);
		// Releasing twice is harmless, also once another command holds the lock.
		heldBy(4242, 'node deploy');
		lock.release();
		assert.equal(JSON.parse(readFileSync(lockFile, 'utf-8')).pid, 4242);
	});

	it('refuses, naming the pid and the command of a holder that still runs, and leaves its lock', () => {
		heldBy(4242, 'node deploy', 'npm run deploy -- --profile prod');
		const before = readFileSync(lockFile, 'utf-8');
		assert.throws(
			() => acquireSynthLock(root, 'npm run destroy', running(4242)),
			(error: Error) => {
				assert.match(error.message, /^`npm run deploy -- --profile prod` \(pid 4242\) is generating the client and synthesizing this app/);
				assert.match(error.message, /Nothing was generated or built\. Wait for it to finish its synth, then re-run `npm run destroy`\.$/);
				return true;
			},
		);
		assert.equal(readFileSync(lockFile, 'utf-8'), before);
	});

	it('refuses a second acquire of this same process', () => {
		const lock = acquireSynthLock(root, 'npm run deploy', running());
		assert.throws(() => acquireSynthLock(root, 'npm run destroy', running()), new RegExp(`\\(pid ${process.pid}\\)`));
		lock.release();
		acquireSynthLock(root, 'npm run destroy', running()).release();
	});

	it('takes over the lock of a process that is gone', () => {
		heldBy(4242, 'node deploy');
		const lock = acquireSynthLock(root, 'npm run deploy', running());
		assert.equal(JSON.parse(readFileSync(lockFile, 'utf-8')).pid, process.pid);
		lock.release();
		assert.deepEqual(readdirSync(join(root, '.cdk-blocks-sandbox')), []);
	});

	it('takes over the lock of a pid that now runs another command', () => {
		// The OS handed pid 4242 to another program after the holder died.
		heldBy(4242, 'node the-deploy-that-died');
		const lock = acquireSynthLock(root, 'npm run deploy', running(4242));
		assert.equal(JSON.parse(readFileSync(lockFile, 'utf-8')).pid, process.pid);
		lock.release();
	});

	it('takes over a lock file that holds no record', () => {
		mkdirSync(join(root, '.cdk-blocks-sandbox'), { recursive: true });
		writeFileSync(lockFile, 'not a record');
		const lock = acquireSynthLock(root, 'npm run deploy', running());
		assert.equal(JSON.parse(readFileSync(lockFile, 'utf-8')).pid, process.pid);
		lock.release();
	});

	it('is released when the process exits without releasing it', () => {
		const before = process.listenerCount('exit');
		const lock = acquireSynthLock(root, 'npm run deploy', running());
		assert.equal(process.listenerCount('exit'), before + 1);
		// A release takes the exit hook away again: a long-running process does not collect them.
		lock.release();
		assert.equal(process.listenerCount('exit'), before);
	});
});
