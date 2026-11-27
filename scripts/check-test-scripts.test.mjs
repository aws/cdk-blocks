// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { findUnrunTests, shExpand } from './check-test-scripts.mjs';

const tempDirs = [];
after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeTree(files) {
	const root = mkdtempSync(join(tmpdir(), 'check-test-scripts-'));
	tempDirs.push(root);
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), content);
	}
	return root;
}

function repoWith(script, sources) {
	return writeTree({
		'package.json': JSON.stringify({ workspaces: ['packages/a'] }),
		'packages/a/package.json': JSON.stringify({ name: 'a', scripts: { test: script } }),
		...Object.fromEntries(sources.map((source) => [`packages/a/${source}`, ''])),
	});
}

function unrun(script, sources) {
	return findUnrunTests(repoWith(script, sources)).map((finding) => finding.testFile);
}

describe('findUnrunTests', () => {
	it('reports the file a hand-kept list misses, with the path to add', () => {
		const script = 'node --test --test-concurrency=1 dist/index.test.js dist/parity.test.js';
		const root = repoWith(script, ['src/index.test.ts', 'src/parity.test.ts', 'src/user-agent.test.ts', 'src/index.ts']);
		const findings = findUnrunTests(root);
		assert.deepEqual(
			findings.map(({ workspace, testFile, script }) => ({ workspace, testFile, script })),
			[{ workspace: 'packages/a', testFile: 'src/user-agent.test.ts', script }],
		);
		assert.match(findings[0].fix, /add dist\/user-agent\.test\.js /);
		assert.match(findings[0].fix, /'dist\/\*\*\/\*\.test\.js'/);
	});

	it('reports top-level tests when an unquoted ** glob meets a nested test', () => {
		const root = repoWith('node --test dist/**/*.test.js', ['src/defaults.test.ts', 'src/adapters/nextjs.test.ts']);
		const findings = findUnrunTests(root);
		assert.deepEqual(
			findings.map((finding) => finding.testFile),
			['src/defaults.test.ts'],
		);
		assert.match(findings[0].fix, /unquoted/);
		assert.match(findings[0].fix, /sh expands \*\* as \*/);
		assert.match(findings[0].fix, /'dist\/\*\*\/\*\.test\.js'/);
	});

	it('accepts an unquoted ** glob while every test is top-level', () => {
		assert.deepEqual(unrun('node --test dist/**/*.test.js', ['src/index.test.ts', 'src/parity.test.ts']), []);
	});

	it('accepts the quoted ** glob at every depth', () => {
		const sources = ['src/defaults.test.ts', 'src/adapters/nextjs.test.ts', 'src/adapters/shared/basepath.test.tsx'];
		assert.deepEqual(unrun("node --test 'dist/**/*.test.js'", sources), []);
		assert.deepEqual(unrun('node --test "dist/**/*.test.js"', sources), []);
	});

	it('reports a test two directories deep under `dist/*.test.js dist/**/*.test.js`', () => {
		const sources = ['src/index.test.ts', 'src/cli/run.test.ts', 'src/cli/commands/deploy.test.ts'];
		assert.deepEqual(unrun('node --env-file=../../test.env --test dist/*.test.js dist/**/*.test.js', sources), [
			'src/cli/commands/deploy.test.ts',
		]);
	});

	it('unions the invocations joined by && and skips their flags', () => {
		const script =
			'node --test --test-force-exit dist/index.test.js && node --conditions=cdk --test dist/index.cdk.test.js && node --conditions aws-runtime --import ./dist/setup.js --test dist/aws/*.test.js';
		const sources = ['src/index.test.ts', 'src/index.cdk.test.ts', 'src/aws/index.aws.test.ts', 'src/other.test.ts'];
		assert.deepEqual(unrun(script, sources), ['src/other.test.ts']);
	});

	it('ignores commands that do not run tests', () => {
		assert.deepEqual(unrun('echo dist/index.test.js; node dist/index.test.js', ['src/index.test.ts']), [
			'src/index.test.ts',
		]);
	});

	it('finds nothing in this repository', () => {
		assert.deepEqual(findUnrunTests(resolve(import.meta.dirname, '..')), []);
	});
});

describe('shExpand', () => {
	const paths = [
		'dist/index.test.js',
		'dist/index.js',
		'dist/cli/run.test.js',
		'dist/cli/commands/deploy.test.js',
		'dist/legacy/cdk.test.js',
		'scripts/pack.test.mjs',
	];
	const patterns = [
		'dist/**/*.test.js',
		'dist/*.test.js',
		'dist/**/**/*.test.js',
		'dist/*/*/*.test.js',
		'**/*.test.js',
		'dist/**',
		'dist/cl?/*.test.js',
		'dist/[cl]*/*.test.js',
		'*/*.test.mjs',
		'dist/**/*.spec.js',
	];

	it('matches what sh expands in a real directory', { skip: process.platform === 'win32' }, () => {
		const root = writeTree(Object.fromEntries(paths.map((path) => [path, ''])));
		const entries = [
			...new Set(paths.flatMap((path) => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')))),
		];
		for (const pattern of patterns) {
			const printed = execFileSync('sh', ['-c', `printf '%s\\n' ${pattern}`], { cwd: root, encoding: 'utf8' });
			const expanded = printed.split('\n').filter((line) => line !== '' && line !== pattern);
			assert.deepEqual(shExpand(pattern, entries).sort(), expanded.sort(), pattern);
		}
		assert.deepEqual(shExpand('dist/**/*.test.js', entries), ['dist/cli/run.test.js', 'dist/legacy/cdk.test.js']);
	});
});
