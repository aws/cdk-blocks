// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The TLC outputs are shortened from what TLC prints, so the tests need no Java.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	counterexampleOf,
	digestOf,
	failureOf,
	memberText,
	readTlc,
	stateCountOf,
	unconfirmedOf,
} from './check-formal-models.mjs';

const PASS = `Starting... (2026-11-24 22:35:44)
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-11-24 22:35:44.
Model checking completed. No error has been found.
  Estimates of the probability that TLC did not check all reachable states
  because two distinct states had the same fingerprint:
  calculated (optimistic):  val = 3.8E-14
1675 states generated, 761 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 13.
Finished in 00s at (2026-11-24 22:35:45)
`;

const VIOLATION = `Finished computing initial states: 1 distinct state generated at 2026-11-24 22:35:45.
Error: Invariant SignOutSticks is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\\ row = [version |-> 1, tokens |-> "signIn"]
/\\ signOut = "lookup"

State 2: <SignOutDelete line 204, col 5 to line 207, col 66 of module SessionRefresh>
/\\ row = [version |-> 0, tokens |-> "none"]
/\\ signOut = "done"

State 3: <UpdateSessionPut("r1") line 182, col 5 to line 187, col 43 of module SessionRefresh>
/\\ row = [version |-> 2, tokens |-> "r1"]
/\\ signOut = "done"

453 states generated, 233 distinct states found, 95 states left on queue.
The depth of the complete state graph search is 7.
Finished in 00s at (2026-11-24 22:35:45)
`;

const PARSE_ERROR = `***Parse Error***
Encountered "Beginning of definition" at line 86, column 1 and token "="

Fatal errors while parsing TLA+ spec in file SessionRefresh

Starting... (2026-11-24 22:36:13)
Error: Parsing or semantic analysis failed.
Finished in 00s at (2026-11-24 22:36:13)
`;

const DEADLOCK = `Error: Deadlock reached.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\\ signOut = "lookup"

813 states generated, 414 distinct states found, 147 states left on queue.
`;

const holds = { config: 'Head.cfg', expect: 'holds' };
const violates = { config: 'PreFix.SignOutSticks.cfg', expect: 'violates', invariant: 'SignOutSticks' };

describe('readTlc', () => {
	it('reads a run with no error as holds', () => {
		assert.deepEqual(readTlc(0, PASS), { kind: 'holds' });
	});

	it('names the violated invariant', () => {
		assert.deepEqual(readTlc(12, VIOLATION), { kind: 'violates', invariant: 'SignOutSticks' });
	});

	it('reads a parse error, a deadlock and a missing verdict as an error', () => {
		assert.deepEqual(readTlc(150, PARSE_ERROR), { kind: 'error' });
		assert.deepEqual(readTlc(11, DEADLOCK), { kind: 'error' });
		assert.deepEqual(readTlc(0, ''), { kind: 'error' });
	});

	it('does not read a non-zero exit as holds', () => {
		assert.deepEqual(readTlc(1, PASS), { kind: 'error' });
	});
});

describe('failureOf', () => {
	it('passes a model that holds as expected', () => {
		assert.equal(failureOf(holds, readTlc(0, PASS)), null);
	});

	it('passes a model that violates the expected invariant', () => {
		assert.equal(failureOf(violates, readTlc(12, VIOLATION)), null);
	});

	it('fails a model that should hold and is violated, naming the invariant', () => {
		assert.equal(failureOf(holds, readTlc(12, VIOLATION)), 'violates SignOutSticks');
	});

	it('fails a model that should be violated and holds', () => {
		assert.equal(failureOf(violates, readTlc(0, PASS)), 'holds, expected to violate SignOutSticks');
	});

	it('fails a model that violates a different invariant', () => {
		assert.equal(
			failureOf({ ...violates, invariant: 'NoStaleDelete' }, readTlc(12, VIOLATION)),
			'violates SignOutSticks, expected to violate NoStaleDelete',
		);
	});

	it('fails a model that expects a violation and names no invariant', () => {
		assert.notEqual(failureOf({ config: 'PreFix.cfg', expect: 'violates' }, readTlc(12, VIOLATION)), null);
	});

	it('fails on a TLC error whatever the entry expects', () => {
		assert.equal(failureOf(holds, readTlc(150, PARSE_ERROR)), 'TLC failed');
		assert.equal(failureOf(violates, readTlc(150, PARSE_ERROR)), 'TLC failed');
		assert.equal(failureOf(violates, readTlc(11, DEADLOCK)), 'TLC failed');
	});

	it('fails an entry whose expect is neither holds nor violates', () => {
		assert.equal(failureOf({ config: 'Head.cfg', expect: 'pass' }, readTlc(0, PASS)), 'unknown expect "pass"');
	});
});

describe('counterexampleOf', () => {
	it('keeps the violated invariant and every state, and drops the statistics', () => {
		const trace = counterexampleOf(VIOLATION);
		assert.ok(trace.startsWith('Error: Invariant SignOutSticks is violated.'));
		assert.ok(trace.endsWith('/\\ signOut = "done"'));
		assert.equal(trace.match(/^State \d+:/gm).length, 3);
		assert.ok(!trace.includes('states generated'));
	});

	it('is empty for a run with no violation', () => {
		assert.equal(counterexampleOf(PASS), '');
	});
});

describe('stateCountOf', () => {
	it('reads the generated and distinct state counts', () => {
		assert.equal(stateCountOf(PASS), '1675 states generated, 761 distinct states found');
		assert.equal(stateCountOf(PARSE_ERROR), 'no state count');
	});
});

const SOURCE = [
	'function versionOf(row: unknown): number | undefined {',
	"\treturn typeof row === 'object' ? 1 : undefined;",
	'}',
	'',
	'export class SessionStore {',
	'\t/** Replace only if unchanged. */',
	'\tasync replaceIfUnchanged(sessionId: string, row: unknown): Promise<boolean> {',
	'\t\ttry {',
	'\t\t\tawait this.kv.put(sessionId, row, { ...unchangedSince(row) });',
	'\t\t\treturn true;',
	'\t\t} catch (e) {',
	'\t\t\treturn false;',
	'\t\t}',
	'\t}',
	'',
	'\tasync delete(sessionId: string): Promise<void> {',
	'\t\tawait this.kv.delete(sessionId);',
	'\t}',
	'}',
].join('\n');

describe('memberText', () => {
	it('is a method from its signature to its closing brace, without the JSDoc above it', () => {
		const text = memberText(SOURCE, 'replaceIfUnchanged');
		assert.ok(text.startsWith('\tasync replaceIfUnchanged('));
		assert.ok(text.endsWith('\t\t}\n\t}'));
		assert.ok(!text.includes('delete('));
	});

	it('finds a top-level function and tells delete from deleteIfUnchanged', () => {
		assert.ok(memberText(SOURCE, 'versionOf').endsWith('undefined;\n}'));
		assert.ok(memberText(SOURCE, 'delete').startsWith('\tasync delete('));
	});

	it('is null for a name the source does not define', () => {
		assert.equal(memberText(SOURCE, 'replace'), null);
	});
});

describe('unconfirmedOf', () => {
	const covers = (source) => ({
		'sessions.ts': {
			replaceIfUnchanged: digestOf(memberText(source, 'replaceIfUnchanged')),
			delete: digestOf(memberText(source, 'delete')),
		},
	});

	it('is empty while every covered function has the text it was confirmed against', () => {
		assert.deepEqual(unconfirmedOf({ covers: covers(SOURCE) }, () => SOURCE), []);
	});

	it('names the function whose condition was dropped, and no other', () => {
		const changed = SOURCE.replace('{ ...unchangedSince(row) }', '{}');
		assert.deepEqual(
			unconfirmedOf({ covers: covers(SOURCE) }, () => changed).map(({ file, member }) => ({ file, member })),
			[{ file: 'sessions.ts', member: 'replaceIfUnchanged' }],
		);
	});

	it('ignores a change outside the covered functions', () => {
		const changed = SOURCE.replace('Replace only if unchanged.', 'Compare and swap.').replace(': undefined;', ': 0;');
		assert.deepEqual(unconfirmedOf({ covers: covers(SOURCE) }, () => changed), []);
	});

	it('reports a covered function that is gone with a null digest', () => {
		const gone = SOURCE.replace('async delete(', 'async remove(');
		assert.deepEqual(unconfirmedOf({ covers: covers(SOURCE) }, () => gone), [
			{ file: 'sessions.ts', member: 'delete', digest: null },
		]);
	});

	it('is empty for an entry that covers no code', () => {
		assert.deepEqual(unconfirmedOf({}, () => SOURCE), []);
	});
});
