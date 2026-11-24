// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A test file that its workspace's `npm test` never selects fails nothing. npm
// runs scripts through `sh`, which has no globstar: an unquoted
// `dist/**/*.test.js` reaches node as `dist/<one dir>/*.test.js`. While no test
// sits one directory deep, `sh` leaves the pattern as written and node expands
// it, so the script works until the first nested test is added.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, matchesGlob, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readWorkspaces } from './ci/unit-test-shard.mjs';

const TEST_SOURCE = /\.test\.tsx?$/;
const GLOB_CHARS = /[*?[]/;
const RUNNERS = new Set(['node', 'tsx']);
const FLAGS_WITH_VALUE = new Set(['--import', '--require', '-r', '--env-file', '--conditions', '-C']);
const QUOTED_GLOB = "'dist/**/*.test.js'";

function compiledPath(testFile) {
	return testFile.replace(/^src\//, 'dist/').replace(TEST_SOURCE, '.test.js');
}

function listTestSources(workspaceDir) {
	const src = join(workspaceDir, 'src');
	if (!existsSync(src)) return [];
	return readdirSync(src, { recursive: true })
		.map((file) => `src/${file.replaceAll('\\', '/')}`)
		.filter((file) => TEST_SOURCE.test(file))
		.sort();
}

function parseCommands(script) {
	const commands = [[]];
	let token = null;
	const endToken = () => {
		if (token) commands.at(-1).push(token);
		token = null;
	};
	for (let i = 0; i < script.length; i++) {
		const char = script[i];
		if (char === "'" || char === '"') {
			const close = script.indexOf(char, i + 1);
			const end = close === -1 ? script.length : close;
			token = { text: (token?.text ?? '') + script.slice(i + 1, end), quoted: true };
			i = end;
		} else if (/\s/.test(char)) {
			endToken();
		} else if (char === ';' || ((char === '&' || char === '|') && script[i + 1] === char)) {
			endToken();
			commands.push([]);
			if (char !== ';') i++;
		} else {
			token = { text: (token?.text ?? '') + char, quoted: token?.quoted ?? false };
		}
	}
	endToken();
	return commands;
}

function testFileArgs(script) {
	return parseCommands(script).flatMap((tokens) => {
		const runner = tokens.findIndex((token) => RUNNERS.has(token.text));
		if (runner === -1 || !tokens.some((token) => token.text === '--test')) return [];
		const args = [];
		for (let i = runner + 1; i < tokens.length; i++) {
			if (FLAGS_WITH_VALUE.has(tokens[i].text)) i++;
			else if (!tokens[i].text.startsWith('-')) args.push(tokens[i]);
		}
		return args;
	});
}

/**
 * The entries of `paths` that POSIX `sh` pathname expansion of `pattern`
 * produces: `**` matches like `*`, and `*` and `?` do not cross `/`.
 */
export function shExpand(pattern, paths) {
	const shPattern = pattern.replace(/\*{2,}/g, '*');
	return paths.filter((path) => matchesGlob(path, shPattern));
}

function selectedBy({ text, quoted }, paths) {
	const pattern = posix.normalize(text);
	if (!quoted && GLOB_CHARS.test(pattern)) {
		const expanded = shExpand(pattern, paths);
		if (expanded.length > 0) return expanded;
	}
	return paths.filter((path) => matchesGlob(path, pattern));
}

function fixFor(compiled, args) {
	const unquoted = args.find(
		(arg) => !arg.quoted && arg.text.includes('**') && matchesGlob(compiled, posix.normalize(arg.text)),
	);
	if (unquoted) {
		return `the glob ${unquoted.text} is unquoted, so sh expands ** as * before node sees it; write it as '${unquoted.text}'`;
	}
	return `add ${compiled} to scripts.test, or replace the file list with ${QUOTED_GLOB}`;
}

/**
 * Every test source file that its workspace's `scripts.test` does not run, as
 * `{ workspace, testFile, script, fix }`. Workspaces without a package.json,
 * a `scripts.test` or test sources under `src/` have nothing to check.
 */
export function findUnrunTests(rootDir) {
	return readWorkspaces(rootDir).flatMap((workspace) => {
		const manifest = join(rootDir, workspace, 'package.json');
		if (!existsSync(manifest)) return [];
		const script = JSON.parse(readFileSync(manifest, 'utf8')).scripts?.test;
		if (typeof script !== 'string') return [];
		const testFiles = listTestSources(join(rootDir, workspace));
		const compiled = testFiles.map(compiledPath);
		const args = testFileArgs(script);
		const run = new Set(args.flatMap((arg) => selectedBy(arg, compiled)));
		return testFiles
			.filter((_, i) => !run.has(compiled[i]))
			.map((testFile) => ({ workspace, testFile, script, fix: fixFor(compiledPath(testFile), args) }));
	});
}

function main(argv) {
	const { values } = parseArgs({ args: argv, options: { root: { type: 'string' } } });
	const root = resolve(values.root ?? join(import.meta.dirname, '..'));
	const findings = findUnrunTests(root);
	for (const { workspace, testFile, fix } of findings) {
		console.error(`${workspace}/${testFile} is never run by "npm test": ${fix}`);
	}
	if (findings.length > 0) {
		console.error(`check-test-scripts: ${findings.length} test file(s) are not run by their workspace's scripts.test`);
		process.exit(1);
	}
	console.log('check-test-scripts: every src test file is run by its workspace');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(`check-test-scripts: ${err.message}`);
		process.exit(1);
	}
}
