// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeBinsExecutable } from './chmod-bins.mjs';

// Windows has no execute permission: npm writes a `.cmd` shim for each bin there.
const posix = process.platform !== 'win32';

/** Write `files` (path to content) under `root` without the execute permission. */
function write(root, files) {
	for (const [path, content] of Object.entries(files)) {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
		chmodSync(file, 0o644);
	}
}

const executable = (file) => (statSync(file).mode & 0o111) === 0o111;

describe('makeBinsExecutable', { skip: !posix }, () => {
	let root;

	before(() => {
		root = mkdtempSync(join(tmpdir(), 'chmod-bins-'));
		write(root, {
			'package.json': { workspaces: ['packages/map', 'packages/string', 'packages/none', 'packages/gone'] },
			'packages/map/package.json': { bin: { built: './dist/cli.js', 'not-built': './dist/missing.js' } },
			'packages/map/dist/cli.js': '#!/usr/bin/env node\n',
			'packages/map/dist/index.js': 'export {};\n',
			'packages/string/package.json': { bin: 'dist/bin.js' },
			'packages/string/dist/bin.js': '#!/usr/bin/env node\n',
			'packages/none/package.json': { name: 'none' },
			'packages/none/dist/index.js': 'export {};\n',
		});
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	it('makes each built bin target executable and leaves other files as they are', () => {
		const changed = makeBinsExecutable(root);

		assert.deepStrictEqual(changed.sort(), [
			join(root, 'packages/map/dist/cli.js'),
			join(root, 'packages/string/dist/bin.js'),
		]);
		assert.ok(executable(join(root, 'packages/map/dist/cli.js')));
		assert.ok(executable(join(root, 'packages/string/dist/bin.js')));
		assert.ok(!executable(join(root, 'packages/map/dist/index.js')));
		assert.ok(!executable(join(root, 'packages/none/dist/index.js')));
	});

	it('changes nothing on a second run', () => {
		assert.deepStrictEqual(makeBinsExecutable(root), []);
	});
});
