// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Make the built `bin` target of every workspace executable.
 *
 * `tsc` writes each output file without the execute permission, and npm sets it
 * only when it links a bin at install time. After a clean build, a bin that an
 * earlier install linked (`node_modules/.bin/<name>`) fails with "Permission
 * denied". The root `build` script runs this file last.
 *
 * Usage:
 *   node scripts/chmod-bins.mjs
 */

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXECUTE = 0o111;

/**
 * Adds the execute permission to every existing `bin` target of the workspaces
 * that `<root>/package.json` lists. A target that the build did not write is
 * skipped.
 *
 * @param {string} root - The directory of the root `package.json`.
 * @returns {string[]} The absolute paths whose mode changed.
 */
export function makeBinsExecutable(root) {
	const changed = [];
	const { workspaces = [] } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
	for (const workspace of workspaces) {
		const manifest = join(root, workspace, 'package.json');
		if (!existsSync(manifest)) continue;
		const { bin } = JSON.parse(readFileSync(manifest, 'utf-8'));
		const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
		for (const target of targets) {
			const file = resolve(root, workspace, target);
			if (!existsSync(file)) continue;
			const { mode } = statSync(file);
			if ((mode & EXECUTE) === EXECUTE) continue;
			chmodSync(file, mode | EXECUTE);
			changed.push(file);
		}
	}
	return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	makeBinsExecutable(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
