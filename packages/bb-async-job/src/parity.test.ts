// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock↔AWS parity for `AsyncJob.submit()` / `submitBatch()` input validation.
 *
 * Each case runs the same `delaySeconds` through the local mock and through the
 * AWS runtime with the SQS client stubbed, and asserts both reach the same
 * outcome: the same named `AsyncJobErrors` error (and message), or success. For
 * success cases the captured SQS command input is asserted too, so a stub that
 * rejects every command cannot make a case pass vacuously; for rejected cases
 * the test asserts nothing reached SQS and the mock queued nothing.
 *
 * Following `bb-file-bucket/src/parity.test.ts`.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isWireSafeError, registerSdkIdentifiers, Scope } from '@aws-cdk-blocks/core';
import { AsyncJob as AwsAsyncJob } from './index.aws.js';
import { AsyncJobErrors, AsyncJob as MockAsyncJob } from './index.mock.js';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/000000000000/parity-queue';

let n = 0;
const uniqueId = () => `aj-parity-${Date.now()}-${n++}`;

type Outcome = { ok: true } | { ok: false; name: string; message: string; wireSafe: boolean };

async function outcomeOf(fn: () => Promise<unknown>): Promise<Outcome> {
	try {
		await fn();
		return { ok: true };
	} catch (e) {
		const err = e as Error;
		return { ok: false, name: err.name, message: err.message, wireSafe: isWireSafeError(err) };
	}
}

interface SentInput {
	QueueUrl?: string;
	DelaySeconds?: number;
	Entries?: Array<{ Id: string; DelaySeconds?: number }>;
}

/** An AWS-runtime AsyncJob whose SQS client records every command and succeeds. */
function makeAwsJob() {
	const job = new AwsAsyncJob<{ n: number }>(new Scope('app'), uniqueId(), { handler: async () => {} });
	registerSdkIdentifiers(job.fullId, { queueUrl: QUEUE_URL });
	const inputs: SentInput[] = [];
	// Test plumbing: swap the private SDK client for a recording stub.
	(job as unknown as { _sqsClient: unknown })._sqsClient = {
		send: async (cmd: { input: SentInput }) => {
			inputs.push(cmd.input);
			if (cmd.input.Entries) {
				return {
					Successful: cmd.input.Entries.map((e) => ({ Id: e.Id, MessageId: `msg-${e.Id}` })),
					Failed: [],
				};
			}
			return { MessageId: 'msg-single' };
		},
	};
	return { job, inputs };
}

function makeMockJob() {
	return new MockAsyncJob<{ n: number }>(new Scope('app'), uniqueId(), { handler: async () => {} });
}

interface Case {
	label: string;
	/** `undefined` means the option is omitted. */
	delaySeconds: number | undefined;
	/** `null` = success; otherwise the expected `AsyncJobErrors` name. */
	error: string | null;
}

// SQS accepts an integer DelaySeconds from 0 to 900 on SendMessage and on each
// SendMessageBatch entry, and rejects anything else with InvalidParameterValue.
const cases: Case[] = [
	{ label: 'delaySeconds omitted', delaySeconds: undefined, error: null },
	{ label: 'delaySeconds 0', delaySeconds: 0, error: null },
	{ label: 'delaySeconds 900 (upper bound)', delaySeconds: 900, error: null },
	{ label: 'delaySeconds -1', delaySeconds: -1, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds 901', delaySeconds: 901, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds 3600', delaySeconds: 3600, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds 1.5 (not an integer)', delaySeconds: 1.5, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds NaN', delaySeconds: Number.NaN, error: AsyncJobErrors.ValidationFailed },
	{ label: 'delaySeconds Infinity', delaySeconds: Number.POSITIVE_INFINITY, error: AsyncJobErrors.ValidationFailed },
];

function assertSameOutcome(c: Case, mockOutcome: Outcome, awsOutcome: Outcome): void {
	assert.deepStrictEqual(awsOutcome, mockOutcome, 'mock and AWS outcomes differ');
	if (c.error === null) {
		assert.deepStrictEqual(mockOutcome, { ok: true });
	} else {
		assert.strictEqual(mockOutcome.ok, false);
		if (!mockOutcome.ok) {
			assert.strictEqual(mockOutcome.name, c.error);
			// Branded, so the name survives the RPC boundary instead of collapsing to a nameless 500.
			assert.strictEqual(mockOutcome.wireSafe, true);
		}
	}
}

describe('AsyncJob.submit() validates delaySeconds the same way on mock and AWS', () => {
	for (const c of cases) {
		test(c.label, async () => {
			const options = c.delaySeconds === undefined ? undefined : { delaySeconds: c.delaySeconds };

			const mockJob = makeMockJob();
			const mockOutcome = await outcomeOf(() => mockJob.submit({ n: 1 }, options));

			const { job: awsJob, inputs } = makeAwsJob();
			const awsOutcome = await outcomeOf(() => awsJob.submit({ n: 1 }, options));

			assertSameOutcome(c, mockOutcome, awsOutcome);
			if (c.error === null) {
				assert.deepStrictEqual(
					inputs.map((i) => ({ QueueUrl: i.QueueUrl, DelaySeconds: i.DelaySeconds })),
					[{ QueueUrl: QUEUE_URL, DelaySeconds: c.delaySeconds ?? 0 }],
				);
				assert.strictEqual(mockJob._queue.totalSubmitted, 1);
			} else {
				assert.deepStrictEqual(inputs, [], 'nothing should reach SQS');
				assert.strictEqual(mockJob._queue.totalSubmitted, 0, 'the mock should queue nothing');
			}
		});
	}
});

describe('AsyncJob.submitBatch() validates delaySeconds the same way on mock and AWS', () => {
	for (const c of cases) {
		test(c.label, async () => {
			const options = c.delaySeconds === undefined ? undefined : { delaySeconds: c.delaySeconds };
			const payloads = [{ n: 1 }, { n: 2 }];

			const mockJob = makeMockJob();
			const mockOutcome = await outcomeOf(() => mockJob.submitBatch(payloads, options));

			const { job: awsJob, inputs } = makeAwsJob();
			const awsOutcome = await outcomeOf(() => awsJob.submitBatch(payloads, options));

			assertSameOutcome(c, mockOutcome, awsOutcome);
			if (c.error === null) {
				assert.deepStrictEqual(
					inputs.map((i) => ({ QueueUrl: i.QueueUrl, Entries: i.Entries?.map((e) => e.DelaySeconds) })),
					[{ QueueUrl: QUEUE_URL, Entries: [c.delaySeconds ?? 0, c.delaySeconds ?? 0] }],
				);
				assert.strictEqual(mockJob._queue.totalSubmitted, 2);
			} else {
				// Rejected as a whole with the validation error, not wrapped in
				// BatchSubmitFailedException after SQS refuses each entry.
				assert.deepStrictEqual(inputs, [], 'nothing should reach SQS');
				assert.strictEqual(mockJob._queue.totalSubmitted, 0, 'the mock should queue nothing');
			}
		});
	}
});
