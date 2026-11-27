// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs TLC on every entry of formal/models.json and compares the result with
 * the entry's `expect`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const formalRoot = join(repoRoot, 'formal');

// The newest release whose jar does not change. The `v1.8.0` release is a
// pre-release that upstream rebuilds in place, so no checksum of it stays valid.
const JAR_URL = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';
const JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const JAR_CACHE = join(repoRoot, '.cache', `tla2tools-${JAR_SHA256.slice(0, 12)}.jar`);

/**
 * What a TLC run found: `{ kind: 'holds' }`, `{ kind: 'violates', invariant }`
 * or `{ kind: 'error' }` for anything else (a parse error, a deadlock, a crash).
 */
export function readTlc(status, output) {
	const violated = output.match(/^Error: Invariant (\S+) is violated\.$/m);
	if (violated) return { kind: 'violates', invariant: violated[1] };
	if (status === 0 && output.includes('Model checking completed. No error has been found.')) {
		return { kind: 'holds' };
	}
	return { kind: 'error' };
}

/** Why `result` is not what `entry` expects, or `null` when it is. */
export function failureOf(entry, result) {
	if (result.kind === 'error') return 'TLC failed';
	const found = result.kind === 'holds' ? 'holds' : `violates ${result.invariant}`;
	if (entry.expect === 'holds') return result.kind === 'holds' ? null : found;
	if (entry.expect === 'violates') {
		if (result.kind === 'violates' && result.invariant === entry.invariant) return null;
		return `${found}, expected to violate ${entry.invariant}`;
	}
	return `unknown expect ${JSON.stringify(entry.expect)}`;
}

/** The states of TLC's counterexample, from the violated invariant to the last state. */
export function counterexampleOf(output) {
	const lines = output.split('\n');
	const start = lines.findIndex((line) => /^Error: Invariant \S+ is violated\.$/.test(line));
	const end = lines.findIndex((line, i) => i > start && /^\d+ states generated/.test(line));
	return start === -1 ? '' : lines.slice(start, end === -1 ? undefined : end).join('\n').trimEnd();
}

/** TLC's state count line, such as `1675 states generated, 761 distinct states found`. */
export function stateCountOf(output) {
	return output.match(/^(\d+ states generated, \d+ distinct states found)/m)?.[1] ?? 'no state count';
}

const SIGNATURE = /^\t*(?:export )?(?:(?:private|protected|public|static|async|function) )*(\w+)\(/;

/**
 * The text of the function or class member `name` in `source`, from its JSDoc
 * (where the promise the model checks is written) to the closing brace at the
 * same indent. `null` when `source` defines no such member or more than one.
 * Relies on the formatter: a body closes on a line of its own.
 */
export function memberText(source, name) {
	const lines = source.split('\n');
	const signatures = lines.flatMap((line, i) => (line.match(SIGNATURE)?.[1] === name ? [i] : []));
	if (signatures.length !== 1) return null;
	const [signature] = signatures;
	const indent = lines[signature].match(/^\t*/)[0];
	const end = lines.indexOf(`${indent}}`, signature);
	if (end === -1) return null;
	const above = lines[signature - 1] ?? '';
	let start = signature;
	if (above.startsWith(`${indent}/**`) && above.endsWith('*/')) start = signature - 1;
	else if (above === `${indent} */`) start = lines.lastIndexOf(`${indent}/**`, signature);
	return lines.slice(start === -1 ? signature : start, end + 1).join('\n');
}

export function digestOf(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * The covered functions of `entry` whose text is not the text the model was
 * confirmed against, as `{ file, member, digest }`. `digest` is the digest of
 * the text now, or `null` when the function is gone or no longer unique.
 */
export function unconfirmedOf(entry, readSource) {
	return Object.entries(entry.covers ?? {}).flatMap(([file, members]) => {
		const source = readSource(file);
		return Object.entries(members).flatMap(([member, confirmed]) => {
			const text = memberText(source, member);
			const digest = text === null ? null : digestOf(text);
			return digest === confirmed ? [] : [{ file, member, digest }];
		});
	});
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function download(url) {
	let failure;
	for (const waitMs of [0, 2000, 8000]) {
		await new Promise((resolve) => setTimeout(resolve, waitMs));
		try {
			const response = await fetch(url);
			if (response.ok) return Buffer.from(await response.arrayBuffer());
			failure = new Error(`Downloading ${url} failed with HTTP ${response.status}.`);
		} catch (error) {
			failure = new Error(`Downloading ${url} failed: ${error.message}`);
		}
	}
	throw failure;
}

async function tlaToolsJar() {
	if (process.env.TLA2TOOLS_JAR) return process.env.TLA2TOOLS_JAR;
	if (existsSync(JAR_CACHE) && sha256(readFileSync(JAR_CACHE)) === JAR_SHA256) return JAR_CACHE;
	const jar = await download(JAR_URL);
	const actual = sha256(jar);
	if (actual !== JAR_SHA256) {
		throw new Error(
			`${JAR_URL} has sha256 ${actual}, not the pinned ${JAR_SHA256}. Refusing to run it. ` +
				'Review the new jar and update JAR_SHA256, or set TLA2TOOLS_JAR to a jar you trust.',
		);
	}
	mkdirSync(dirname(JAR_CACHE), { recursive: true });
	writeFileSync(JAR_CACHE, jar);
	return JAR_CACHE;
}

function runTlc(jar, entry) {
	// TLC writes a trace spec next to the model, so it runs on a copy.
	const work = mkdtempSync(join(tmpdir(), 'formal-models-'));
	try {
		cpSync(formalRoot, work, { recursive: true });
		const run = spawnSync(
			'java',
			[
				'-XX:+UseParallelGC',
				'-cp',
				jar,
				'tlc2.TLC',
				'-config',
				join(work, entry.config),
				'-workers',
				'1',
				'-metadir',
				join(work, 'states'),
				join(work, entry.spec),
			],
			{ cwd: work, encoding: 'utf8' },
		);
		if (run.error) {
			throw new Error(
				`Could not run java: ${run.error.message}. TLC needs Java 11 or later on the PATH. ` +
					'Set TLA2TOOLS_JAR to use a local tla2tools.jar.',
			);
		}
		return { status: run.status, output: run.stdout + run.stderr };
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function confirm(models, readSource) {
	for (const entry of models) {
		for (const { file, member, digest } of unconfirmedOf(entry, readSource)) {
			if (digest === null) throw new Error(`${file} has no ${member}. Edit "covers" in formal/models.json.`);
			entry.covers[file][member] = digest;
			console.log(`confirmed ${entry.config} against ${file} ${member}`);
		}
	}
	writeFileSync(join(formalRoot, 'models.json'), `${JSON.stringify(models, null, '\t')}\n`);
}

async function main(argv) {
	const models = JSON.parse(readFileSync(join(formalRoot, 'models.json'), 'utf8'));
	const readSource = (file) => readFileSync(join(repoRoot, file), 'utf8');
	if (argv.includes('--confirm')) return confirm(models, readSource);
	const jar = await tlaToolsJar();
	let failures = 0;
	for (const entry of models) {
		const unconfirmed = unconfirmedOf(entry, readSource);
		if (unconfirmed.length > 0) {
			failures++;
			console.error(`FAIL  ${entry.config}: the code it describes changed`);
			for (const { file, member, digest } of unconfirmed) {
				const state = digest === null ? 'is missing or defined more than once' : 'changed';
				console.error(`      ${file} ${member} ${state}`);
			}
			console.error(
				`      Compare ${entry.spec} with the code (${entry.guide}), then record the new text with:\n` +
					'      node scripts/check-formal-models.mjs --confirm',
			);
			continue;
		}
		const { status, output } = runTlc(jar, entry);
		const result = readTlc(status, output);
		const failure = failureOf(entry, result);
		const expected = entry.expect === 'violates' ? `violates ${entry.invariant}` : entry.expect;
		if (failure === null) {
			console.log(`ok    ${entry.config}: ${expected} (${stateCountOf(output)})`);
			continue;
		}
		failures++;
		console.error(`FAIL  ${entry.config}: ${failure}`);
		console.error(`      ${entry.why}`);
		console.error(`      How to read this result: ${entry.guide}`);
		console.error(result.kind === 'violates' ? counterexampleOf(output) : output);
	}
	if (failures > 0) {
		console.error(`\n${failures} of ${models.length} model(s) did not give the expected result.`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
