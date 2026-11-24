// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// compareWithAllowlist, which every sink guard uses: entries name a site by
// file and code, so edits elsewhere in a file don't break them.
//
// Run: node --test scripts/sink-guards/allowlist.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareWithAllowlist, findShellSinks, report } from './sinks.mjs';

const REASON = 'A reason long enough to count as written.';
const site = (file, line, text) => ({ file, line, kind: 'shell-option', text });
const entry = (at, code) => ({ at, site: code, reason: REASON });

describe('compareWithAllowlist', () => {
	it('matches a site by file and code, whatever its line', () => {
		const src = "import { spawn } from 'node:child_process';\nspawn('npm', ['i'], { shell: isWin });";
		const allowlist = [entry('a.ts', 'shell: isWin')];
		// The same site before and after lines are added above it.
		for (const text of [src, `// one\n// two\n${src}`]) {
			const result = compareWithAllowlist(findShellSinks('a.ts', text), allowlist);
			assert.deepEqual(result, { unexpected: [], stale: [] });
		}
	});

	it('reports a site whose code changed, and its entry as stale', () => {
		const result = compareWithAllowlist([site('a.ts', 3, 'shell: true')], [entry('a.ts', 'shell: isWin')]);
		assert.deepEqual(result.unexpected.map((f) => f.text), ['shell: true']);
		assert.deepEqual(result.stale.map((e) => e.site), ['shell: isWin']);
	});

	it('keys by file: the same code in another file is not allowed', () => {
		const result = compareWithAllowlist([site('b.ts', 1, 'shell: isWin')], [entry('a.ts', 'shell: isWin')]);
		assert.equal(result.unexpected.length, 1);
		assert.equal(result.stale.length, 1);
	});

	it('needs one entry per identical site, so a copy is still reported', () => {
		const sites = [site('a.ts', 1, 'shell: isWin'), site('a.ts', 9, 'shell: isWin')];
		assert.deepEqual(compareWithAllowlist(sites, [entry('a.ts', 'shell: isWin'), entry('a.ts', 'shell: isWin')]), {
			unexpected: [],
			stale: [],
		});
		const one = compareWithAllowlist(sites, [entry('a.ts', 'shell: isWin')]);
		assert.deepEqual(one.unexpected.map((f) => f.line), [9]);
		const three = compareWithAllowlist(sites, [entry('a.ts', 'shell: isWin'), entry('a.ts', 'shell: isWin'), entry('a.ts', 'shell: isWin')]);
		assert.equal(three.stale.length, 1);
	});

	it('rejects a file:line entry, a missing site and a missing reason', () => {
		assert.throws(() => compareWithAllowlist([], [entry('a.ts:12', 'x')]), /must be a file path/);
		assert.throws(() => compareWithAllowlist([], [{ at: 'a.ts', reason: REASON }]), /needs the site's code/);
		assert.throws(() => compareWithAllowlist([], [{ at: 'a.ts', site: 'x', reason: 'short' }]), /needs a written reason/);
	});

	it('reports an unexpected site with the entry that would allow it', () => {
		const text = report('shell', compareWithAllowlist([site('a.ts', 4, "shell: os === 'win32'")], []));
		assert.match(text, /a\.ts:4 {2}\[shell-option\] {2}shell: os === 'win32'/);
		assert.match(text, /allow with: \{ at: "a\.ts", site: "shell: os === 'win32'", reason: '…' \}/);
	});
});
