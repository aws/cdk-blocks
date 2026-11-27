// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import type { S3Client } from '@aws-sdk/client-s3';

import { productionDestroyDeps } from './destroy.js';
import {
	type AssemblyStack,
	destroyWasThrottled,
	isThrottleReason,
	runDestroyWithRetries,
	sandboxDestroyDeps,
	stackDeleteThrottled,
	throttleBackoffDelay,
} from './sandbox.js';

// API Gateway allows one DeleteRestApi per 30s per account (a fixed quota), so
// parallel teardowns in one account fail with `Too Many Requests (Service:
// ApiGateway, Status Code: 429)` once CloudFormation's own SDK retries run out.
// The old fixed [60s, 120s] schedule gave up after 3 attempts, and parallel
// destroys retried in lockstep, colliding again. These pin the throttle path:
// jittered exponential backoff, bounded by a wall-clock budget, and ONLY for
// throttle-caused failures.

const MIN = 60_000;

/** A fake clock that each attempt advances by `attemptMs` (a throttled CFN delete runs ~5 min). */
function fakeClock(attemptMs: number) {
	let t = 0;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
		attempt: () => {
			t += attemptMs;
		},
	};
}

describe('runDestroyWithRetries (throttled destroy)', () => {
	it('retries an API Gateway 429 destroy with jittered exponential backoff until it succeeds', async () => {
		const clock = fakeClock(5 * MIN);
		const sleeps: number[] = [];
		const steps: string[] = [];
		let attempts = 0;
		await runDestroyWithRetries({
			runDestroy: () => {
				attempts++;
				steps.push('destroy');
				clock.attempt();
				// Fails 3 times (the old schedule's whole allowance), succeeds on the 4th.
				if (attempts <= 3)
					throw new Error('DELETE_FAILED: Too Many Requests (Service: ApiGateway, Status Code: 429)');
			},
			listStacks: () => [{ stackName: 'stackA' }],
			emptyBuckets: async (stacks) => {
				steps.push(`empty ${stacks.map((st) => st.stackName).join(',')}`);
			},
			isThrottled: async () => true,
			sleep: async (ms) => {
				steps.push('sleep');
				sleeps.push(ms);
				clock.advance(ms);
			},
			now: clock.now,
			random: () => 0.5,
		});
		assert.strictEqual(attempts, 4, 'a throttled destroy gets more than the ordinary 3 attempts');
		// Equal jitter around 60s * 2^n: d/2 + 0.5 * d/2 = 0.75 d.
		assert.deepStrictEqual(sleeps, [45_000, 90_000, 180_000]);
		// A bucket that blocks the delete is the reason this loop exists, so a
		// throttle retry must empty the buckets too, before it waits.
		const retry = ['destroy', 'empty stackA', 'sleep'];
		assert.deepStrictEqual(steps, [...retry, ...retry, ...retry, 'destroy']);
	});

	it('spreads parallel throttled destroys apart (jitter), within [d/2, d] of the exponential step', async () => {
		const low = throttleBackoffDelay(0, {}, () => 0);
		const high = throttleBackoffDelay(0, {}, () => 0.999_999);
		assert.strictEqual(low, 30_000);
		assert.ok(high > 59_000 && high <= 60_000, `high=${high}`);
		// Exponential, capped at 5 min before jitter.
		assert.strictEqual(
			throttleBackoffDelay(1, {}, () => 0),
			60_000,
		);
		assert.strictEqual(
			throttleBackoffDelay(2, {}, () => 0),
			120_000,
		);
		assert.strictEqual(
			throttleBackoffDelay(10, {}, () => 1),
			300_000,
		);
	});

	it('gives up on a throttled destroy once the time budget is spent', async () => {
		const clock = fakeClock(5 * MIN);
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					clock.attempt();
					throw new Error('Too Many Requests (Service: ApiGateway, Status Code: 429)');
				},
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				isThrottled: async () => true,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock.advance(ms);
				},
				now: clock.now,
				random: () => 1,
			}),
			/Too Many Requests/,
		);
		// Budget 20 min from the first failure (t=5): fail@5, +1 -> fail@11, +2 -> fail@18,
		// +4 -> fail@27 (> 5 + 20), stop. The wait that would start past the budget is never taken.
		assert.strictEqual(attempts, 4);
		assert.deepStrictEqual(sleeps, [60_000, 120_000, 240_000]);
		assert.strictEqual(clock.now(), 27 * MIN, 'gives up right after the attempt that follows the last wait');
	});

	it('counts the pending wait against the budget: no throttle retry whose wait would end past it', async () => {
		// Attempts of 5, 5 and 9 min: fail@5, wait 1 -> fail@11, wait 2 -> fail@22,
		// 17 min after the first failure. The next step is 4 min (random 1), so its
		// wait would end 21 min after the first failure, past the 20-min budget.
		const durations = [5 * MIN, 5 * MIN, 9 * MIN];
		let t = 0;
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					t += durations[attempts++] ?? 5 * MIN;
					throw new Error('Too Many Requests (Service: ApiGateway, Status Code: 429)');
				},
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				isThrottled: async () => true,
				sleep: async (ms) => {
					sleeps.push(ms);
					t += ms;
				},
				now: () => t,
				random: () => 1,
			}),
			/Too Many Requests/,
		);
		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [60_000, 120_000]);
	});

	it('says AWS throttling is the cause when the budget runs out on a throttle', async () => {
		const errors = mock.method(console, 'error', () => {});
		try {
			const clock = fakeClock(5 * MIN);
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						clock.attempt();
						throw new Error('Too Many Requests (Service: ApiGateway, Status Code: 429)');
					},
					listStacks: () => [{ stackName: 'stackA' }],
					emptyBuckets: async () => {},
					isThrottled: async () => true,
					sleep: async (ms) => clock.advance(ms),
					now: clock.now,
					random: () => 1,
				}),
				/Too Many Requests/,
			);
			const printed = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
			assert.match(printed, /Destroy failed after retries/);
			assert.match(printed, /The last attempt was throttled by AWS/);
			assert.doesNotMatch(printed, /used up the retry time/);
		} finally {
			errors.mock.restore();
		}
	});

	it('says throttling used up the retry time when an ordinary failure comes after the budget', async () => {
		const errors = mock.method(console, 'error', () => {});
		try {
			const clock = fakeClock(5 * MIN);
			let attempts = 0;
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						clock.attempt();
						throw new Error('x');
					},
					listStacks: () => [{ stackName: 'stackA' }],
					emptyBuckets: async () => {},
					// Throttled 3 times (fail@5, 11, 18), then an ordinary failure at 27, past the budget.
					isThrottled: async () => attempts <= 3,
					sleep: async (ms) => clock.advance(ms),
					now: clock.now,
					random: () => 1,
				}),
			);
			assert.strictEqual(attempts, 4);
			const printed = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
			assert.match(printed, /Earlier attempts were throttled by AWS and used up the retry time/);
			assert.doesNotMatch(printed, /The last attempt was throttled/);
		} finally {
			errors.mock.restore();
		}
	});

	it('keeps both ordinary retries for slow attempts that were never throttled', async () => {
		// Attempts of 25 min put every failure past the 20-min throttle budget,
		// which must only cut ordinary retries after a throttle retry.
		const errors = mock.method(console, 'error', () => {});
		try {
			const clock = fakeClock(25 * MIN);
			let attempts = 0;
			const sleeps: number[] = [];
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						clock.attempt();
						throw new Error('distribution still deleting');
					},
					listStacks: () => [{ stackName: 'stackA' }],
					emptyBuckets: async () => {},
					isThrottled: async () => false,
					sleep: async (ms) => {
						sleeps.push(ms);
						clock.advance(ms);
					},
					now: clock.now,
				}),
				/distribution still deleting/,
			);
			assert.strictEqual(attempts, 3);
			assert.deepStrictEqual(sleeps, [60_000, 120_000]);
			const printed = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
			assert.doesNotMatch(printed, /throttled/);
		} finally {
			errors.mock.restore();
		}
	});

	it('prints no throttle hint when the last failure was not a throttle', async () => {
		const errors = mock.method(console, 'error', () => {});
		try {
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						throw new Error('bucket not empty');
					},
					listStacks: () => [{ stackName: 'stackA' }],
					emptyBuckets: async () => {},
					isThrottled: async () => false,
					sleep: async () => {},
				}),
				/bucket not empty/,
			);
			const printed = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
			assert.match(printed, /Destroy failed after retries/);
			assert.doesNotMatch(printed, /throttled/);
		} finally {
			errors.mock.restore();
		}
	});

	it('never gives a non-throttle failure more than the ordinary [60s, 120s], whatever throttles came between', async () => {
		// Each attempt's classification, in order; the destroy always fails.
		for (const sequence of [
			[false, true, false, false],
			[true, false, true, false, false],
			[true, true, false, false, false],
		]) {
			let attempts = 0;
			const ordinarySleeps: number[] = [];
			let lastThrottled = false;
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						throw new Error('x');
					},
					listStacks: () => [{ stackName: 'stackA' }],
					emptyBuckets: async () => {},
					isThrottled: async () => {
						lastThrottled = sequence[attempts - 1] ?? false;
						return lastThrottled;
					},
					sleep: async (ms) => {
						if (!lastThrottled) ordinarySleeps.push(ms);
					},
					random: () => 0.5,
				}),
			);
			assert.deepStrictEqual(ordinarySleeps, [60_000, 120_000], `sequence ${sequence.join(',')}`);
			assert.strictEqual(attempts, sequence.length, `sequence ${sequence.join(',')}`);
		}
	});

	it('gives no ordinary retry once a throttle backoff has used up the budget', async () => {
		const clock = fakeClock(5 * MIN);
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					clock.attempt();
					throw new Error('x');
				},
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				// Throttled 3 times, then (the RestApi gone) an ordinary failure past the budget.
				isThrottled: async () => attempts <= 3,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock.advance(ms);
				},
				now: clock.now,
				random: () => 1,
			}),
		);
		// fail@5, 11, 18 (throttled; waits 1, 2, 4 min), fail@27 ordinary: 22 min after the first failure > 20.
		assert.strictEqual(attempts, 4);
		assert.deepStrictEqual(sleeps, [60_000, 120_000, 240_000]);
	});

	it('keeps the ordinary [60s, 120s] schedule for a failure that is not a throttle', async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('bucket not empty');
				},
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				isThrottled: async () => false,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
				random: () => 0.5,
			}),
			/bucket not empty/,
		);
		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [60_000, 120_000]);
	});

	it('treats a failure it cannot classify as not a throttle (ordinary schedule)', async () => {
		let attempts = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					attempts++;
					throw new Error('boom');
				},
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				isThrottled: async () => {
					throw new Error('AccessDenied: cloudformation:DescribeStackEvents');
				},
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
			/boom/,
		);
		assert.strictEqual(attempts, 3);
		assert.deepStrictEqual(sleeps, [60_000, 120_000]);
	});

	// In CI the check's own DescribeStackEvents call is often throttled too: the
	// account is under the same API pressure that failed the delete. Falling back
	// to the short ordinary schedule then gave up on a throttled delete.
	for (const [what, error] of [
		[
			'CloudFormation `Throttling: Rate exceeded`',
			Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }),
		],
		[
			'a 429',
			Object.assign(new Error('Too many requests'), {
				name: 'TooManyRequestsException',
				$metadata: { httpStatusCode: 429 },
			}),
		],
	] as const) {
		it(`treats a throttle check that fails on ${what} as a throttle (throttle backoff)`, async () => {
			let attempts = 0;
			const sleeps: number[] = [];
			const warnings: string[] = [];
			const warn = mock.method(console, 'warn', (...a: unknown[]) => {
				warnings.push(a.join(' '));
			});
			try {
				await runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						if (attempts <= 3) throw new Error('cdk destroy exited with code 1');
					},
					listStacks: () => [{ stackName: 'stackA' }],
					emptyBuckets: async () => {},
					isThrottled: async () => {
						throw error;
					},
					sleep: async (ms) => {
						sleeps.push(ms);
					},
					random: () => 0.5,
				});
			} finally {
				warn.mock.restore();
			}
			assert.strictEqual(attempts, 4, 'more than the ordinary 3 attempts');
			assert.deepStrictEqual(sleeps, [45_000, 90_000, 180_000]);
			assert.doesNotMatch(warnings.join('\n'), /using the ordinary retry schedule/);
		});
	}

	it('reads a throttle from the failed attempt’s CDK output without calling isThrottled', async () => {
		let attempts = 0;
		let checks = 0;
		const sleeps: number[] = [];
		const outputs = [
			[
				'stackA | 3/9 | DELETE_FAILED | AWS::ApiGateway::RestApi | Api Too Many Requests (Service: ApiGateway, Status Code: 429)',
			],
			['❌  stackA: destroy failed Error: Throttling: Rate exceeded'],
		];
		await runDestroyWithRetries({
			runDestroy: () => {
				attempts++;
				if (attempts <= 2) throw new Error('cdk destroy exited with code 1');
			},
			attemptOutput: () => outputs[attempts - 1] ?? [],
			listStacks: () => [{ stackName: 'stackA' }],
			emptyBuckets: async () => {},
			isThrottled: async () => {
				checks++;
				return false;
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			random: () => 0.5,
		});
		assert.strictEqual(attempts, 3);
		assert.strictEqual(checks, 0, 'no extra CloudFormation call when the output already names the throttle');
		assert.deepStrictEqual(sleeps, [45_000, 90_000]);
	});

	it('still asks isThrottled when the attempt’s CDK output names no throttle', async () => {
		let checks = 0;
		const sleeps: number[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					throw new Error('boom');
				},
				attemptOutput: () => [
					'stackA | DELETE_FAILED | AWS::S3::Bucket | B The bucket you tried to delete is not empty',
				],
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				isThrottled: async () => {
					checks++;
					return false;
				},
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
			/boom/,
		);
		assert.strictEqual(checks, 3);
		assert.deepStrictEqual(sleeps, [60_000, 120_000]);
	});

	it('stops on a Lambda@Edge replica failure even when the attempt was also throttled', async () => {
		const errors: string[] = [];
		const error = mock.method(console, 'error', (...a: unknown[]) => {
			errors.push(a.join(' '));
		});
		let attempts = 0;
		let slept = false;
		let emptied = false;
		try {
			await assert.rejects(
				runDestroyWithRetries({
					runDestroy: () => {
						attempts++;
						throw new Error('x');
					},
					listStacks: () => [{ stackName: 'edge-lambda-stack-x', region: 'us-east-1' }],
					emptyBuckets: async () => {
						emptied = true;
					},
					isThrottled: async () => true,
					edgeReplicaBlocked: async () => ['edge-lambda-stack-x'],
					sleep: async () => {
						slept = true;
					},
				}),
			);
		} finally {
			error.mock.restore();
		}
		assert.strictEqual(attempts, 1);
		assert.strictEqual(slept, false);
		assert.strictEqual(emptied, false);
		assert.match(errors.join('\n'), /edge-lambda-stack-x can't be deleted yet/);
		assert.doesNotMatch(errors.join('\n'), /throttled by AWS/);
	});

	it('passes the attempt start time so a stale throttle from an earlier attempt is not counted', async () => {
		const clock = fakeClock(5 * MIN);
		const seen: number[] = [];
		const previous: (number | undefined)[] = [];
		await assert.rejects(
			runDestroyWithRetries({
				runDestroy: () => {
					clock.attempt();
					throw new Error('x');
				},
				listStacks: () => [{ stackName: 'stackA' }],
				emptyBuckets: async () => {},
				isThrottled: async (_stacks: AssemblyStack[], since: number, prev?: number) => {
					seen.push(since);
					previous.push(prev);
					return false;
				},
				sleep: async (ms) => clock.advance(ms),
				now: clock.now,
			}),
		);
		// attempt 1 starts at 0; attempt 2 at 5 + 1 = 6 min; attempt 3 at 11 + 2 = 13 min.
		assert.deepStrictEqual(seen, [0, 6 * MIN, 13 * MIN]);
		// ...and when the previous attempt failed, so its events are not read as this one's.
		assert.deepStrictEqual(previous, [undefined, 5 * MIN, 11 * MIN]);
	});
});

describe('destroy call sites', () => {
	// Deleting either `isThrottled` line would silently turn throttle backoff off
	// on that path while every runDestroyWithRetries test stays green.
	it('sandbox:destroy detects throttles, empties buckets and checks Lambda@Edge before a retry, with its own clients', async () => {
		const regions: Array<string | undefined> = [];
		const { cfn, calls } = fakeCfn({ s: attempt('s', 1, THROTTLE) });
		const listed: string[] = [];
		const cfnFor = (region: string | undefined) => {
			regions.push(region);
			return {
				send: async (cmd: { constructor: { name: string }; input: { StackName: string } }) => {
					if (cmd.constructor.name === 'ListStackResourcesCommand') {
						listed.push(cmd.input.StackName);
						return { StackResourceSummaries: [] };
					}
					return cfn.send(cmd as never);
				},
			} as unknown as CloudFormationClient;
		};
		const s3 = { send: async () => ({}) } as unknown as S3Client;
		const deps = sandboxDestroyDeps('/app/cdk-blocks/index.ts', {}, { cfnFor, s3 });
		const stacks = [{ stackName: 's', region: 'eu-west-1' }];
		assert.ok(deps.isThrottled, 'isThrottled is wired');
		assert.deepStrictEqual(deps.attemptOutput?.(), [], 'attemptOutput is wired (nothing retained while uncurated)');
		assert.strictEqual(await deps.isThrottled(stacks, SINCE), true);
		assert.deepStrictEqual(calls, ['s:0']);
		// The previous attempt's failure time reaches the check, so its throttle is not counted again.
		const stale = fakeCfn({ s: shortPreviousAttempt() });
		const staleDeps = sandboxDestroyDeps('/app/cdk-blocks/index.ts', {}, { cfnFor: () => stale.cfn, s3 });
		assert.ok(staleDeps.isThrottled);
		assert.strictEqual(await staleDeps.isThrottled(stacks, SINCE), true, 'without previousFailureAt the skew window lets it in');
		assert.strictEqual(await staleDeps.isThrottled(stacks, SINCE, SINCE - 20_000), false);
		await deps.emptyBuckets(stacks);
		assert.deepStrictEqual(listed, ['s']);
		assert.ok(deps.edgeReplicaBlocked, 'edgeReplicaBlocked is wired');
		await deps.edgeReplicaBlocked([{ stackName: 'edge-lambda-stack-x', region: 'us-east-1' }], SINCE);
		assert.deepStrictEqual(listed, ['s', 'edge-lambda-stack-x']);
		assert.deepStrictEqual(regions, ['eu-west-1', 'eu-west-1', 'us-east-1']);
	});

	it('sandbox:destroy lists, for its own AWS calls, only the stacks in the account STS verified', (t) => {
		// The retry reads the stacks from the assembly `cdk destroy` synthesized, relative to the project root.
		const dir = mkdtempSync(join(tmpdir(), 'bb-sandbox-account-'));
		const cwd = process.cwd();
		process.chdir(dir);
		const warn = mock.method(console, 'warn', () => {});
		t.after(() => {
			process.chdir(cwd);
			warn.mock.restore();
			rmSync(dir, { recursive: true, force: true });
		});
		const assembly = join(dir, '.cdk-blocks-sandbox', 'sandbox-destroy.out');
		mkdirSync(assembly, { recursive: true });
		const stack = (account: string) => ({
			type: 'aws:cloudformation:stack',
			environment: `aws://${account}/eu-west-1`,
			properties: { templateFile: 'stack.template.json' },
		});
		writeFileSync(
			join(assembly, 'manifest.json'),
			JSON.stringify({
				version: '36.0.0',
				artifacts: { mine: stack('111111111111'), agnostic: stack('unknown-account'), foreign: stack('999999999999') },
			}),
		);
		const clients = {
			cfnFor: () => {
				throw new Error('unused');
			},
			s3: {} as never,
		};
		const listed = (account: string | undefined) =>
			sandboxDestroyDeps('/app/cdk-blocks/index.ts', {}, clients, undefined, account)
				.listStacks()
				.map((listedStack) => listedStack.stackName);
		// A stack pinned to another account is never looked up or emptied with these credentials;
		// an environment-agnostic one deploys to their account.
		assert.deepStrictEqual(listed('111111111111'), ['mine', 'agnostic']);
		assert.match(String(warn.mock.calls.at(-1)?.arguments[0]), /Not looking up foreign \(account 999999999999\), .*these credentials are for account 111111111111/);
		// Without a verified account, none is.
		assert.deepStrictEqual(listed(undefined), []);
		assert.match(String(warn.mock.calls.at(-1)?.arguments[0]), /Not looking up mine \(account 111111111111\), agnostic, foreign \(account 999999999999\), .*could not be verified/);
		// One destroy says so once, however often its retry lists the stacks.
		const deps = sandboxDestroyDeps('/app/cdk-blocks/index.ts', {}, clients, undefined, '111111111111');
		const before = warn.mock.callCount();
		deps.listStacks();
		deps.listStacks();
		assert.strictEqual(warn.mock.callCount() - before, 1);
	});

	it('production destroy detects throttles and reads bucket failures before a retry, for each stack in its own Region', async () => {
		const regions: Array<string | undefined> = [];
		const { cfn, calls } = fakeCfn({ 'app-prod': attempt('app-prod', 1, THROTTLE) });
		const cfnFor = (region: string | undefined) => {
			regions.push(region);
			return cfn;
		};
		const s3 = {
			send: async () => {
				throw new Error('no bucket failed to delete: nothing may be emptied');
			},
		} as unknown as S3Client;
		const node = (id: string, region: string, dependencies: string[]) => ({
			id,
			selector: id,
			stackName: id,
			region,
			account: '111111111111',
			dependencies,
		});
		const deps = productionDestroyDeps(
			{ cdkAppPath: 'cdk.ts', projectRoot: '/app' },
			{},
			{
				assemblyDir: '/app/.cdk-blocks-sandbox/destroy-x',
				stacks: [node('app-prod', 'eu-west-1', []), node('app-prod-CfMonitoring-0a1b2c3d', 'us-east-1', ['app-prod'])],
				account: '111111111111',
			},
			{ cfnFor, s3 },
		);
		// The retry gets the stacks the destroy selected, the monitoring stack with us-east-1.
		const stacks = deps.listStacks();
		assert.deepStrictEqual(stacks, [
			{ stackName: 'app-prod', region: 'eu-west-1' },
			{ stackName: 'app-prod-CfMonitoring-0a1b2c3d', region: 'us-east-1' },
		]);
		assert.ok(deps.isThrottled, 'isThrottled is wired');
		assert.deepStrictEqual(deps.attemptOutput?.(), [], 'attemptOutput is wired (nothing retained while uncurated)');
		assert.strictEqual(await deps.isThrottled(stacks, SINCE), true);
		assert.deepStrictEqual(calls, ['app-prod:0']);
		// Before an attempt the newest event of both stacks is read, each in its own Region.
		calls.length = 0;
		regions.length = 0;
		await deps.beforeAttempt?.();
		assert.deepStrictEqual(calls, ['app-prod:0', 'app-prod-CfMonitoring-0a1b2c3d:0']);
		assert.deepStrictEqual(regions, ['eu-west-1', 'us-east-1']);
		assert.strictEqual(deps.successLabel, 'Production stack');
	});

	// The retry's own calls use the credentials CDK destroys with. A stack pinned to another account,
	// looked up by name with them, would be a stack of the same name in THIS account: its buckets
	// must never be emptied. Without a verified account, no stack is known to be in it.
	for (const [name, account, reached] of [
		['only for the stacks in the account STS verified', '111111111111', ['same-account', 'agnostic']],
		['for no stack when the account could not be verified', undefined, []],
	] as const) {
		it(`production destroy makes its own AWS calls ${name}`, async () => {
			const { cfn, calls } = fakeCfn({});
			const listed: string[] = [];
			const cfnFor = () =>
				({
					send: async (cmd: { constructor: { name: string }; input: { StackName: string } }) => {
						if (cmd.constructor.name === 'ListStackResourcesCommand') {
							listed.push(cmd.input.StackName);
							return { StackResourceSummaries: [] };
						}
						return cfn.send(cmd as never);
					},
				}) as unknown as CloudFormationClient;
			const s3 = { send: async () => ({}) } as unknown as S3Client;
			const node = (id: string, stackAccount: string | undefined) => ({
				id,
				selector: id,
				stackName: id,
				region: stackAccount ? 'eu-west-1' : undefined,
				account: stackAccount,
				dependencies: [],
			});
			const deps = productionDestroyDeps(
				{ cdkAppPath: 'cdk.ts', projectRoot: '/app' },
				{},
				{
					assemblyDir: '/app/.cdk-blocks-sandbox/destroy-x',
					stacks: [node('same-account', '111111111111'), node('agnostic', undefined), node('foreign', '999999999999')],
					account,
				},
				{ cfnFor, s3 },
			);
			assert.deepStrictEqual(
				deps.listStacks().map((stack) => stack.stackName),
				reached,
			);
			// A failed destroy, retried once: the throttle check and the bucket emptying get that list.
			const log = mock.method(console, 'log', () => {});
			const error = mock.method(console, 'error', () => {});
			try {
				await assert.rejects(
					runDestroyWithRetries({
						...deps,
						runDestroy: () => {
							throw new Error('delete failed');
						},
						sleep: async () => {},
						retryDelays: [0],
					}),
					/delete failed/,
				);
			} finally {
				log.mock.restore();
				error.mock.restore();
			}
			const lookedUp = [...new Set([...calls.map((call) => call.split(':')[0]), ...listed])];
			assert.deepStrictEqual(lookedUp.sort(), [...reached].sort());
			assert.ok(!lookedUp.includes('foreign'));
		});
	}

	// A production stack retains its data buckets (RemovalPolicy.RETAIN): deleting the stack keeps
	// them, so the retry of a failed delete must not empty them either. It empties a bucket only
	// on the deployed stack's own evidence that, in this attempt, CloudFormation tried to delete
	// it and S3 refused because it holds objects. Anything less empties nothing.
	describe('what the production retry empties', () => {
		const ACCOUNT = '111111111111';
		const NOT_EMPTY = 'The bucket you tried to delete is not empty (Service: S3, Status Code: 409, Request ID: x)';
		const event = (minute: number, type: string, id: string, status: string, physicalId?: string, reason?: string): FakeEvent => ({
			EventId: `${id}:${status}:${minute}`,
			Timestamp: at(minute),
			LogicalResourceId: id,
			PhysicalResourceId: physicalId,
			ResourceType: type,
			ResourceStatus: status,
			ResourceStatusReason: reason,
		});
		const stackEvent = (minute: number, stack: string, status: string) => event(minute, 'AWS::CloudFormation::Stack', stack, status);
		const bucket = (minute: number, id: string, status: string, reason = status === 'DELETE_FAILED' ? NOT_EMPTY : undefined) =>
			event(minute, 'AWS::S3::Bucket', id, status, `${id}-physical`.toLowerCase(), reason);
		const node = (id: string, region: string) => ({ id, selector: id, stackName: id, region, account: ACCOUNT, dependencies: [] });
		const STACKS = [node('app-prod', 'eu-west-1'), node('app-prod-CfMonitoring-0a1b2c3d', 'us-east-1')];

		interface S3Request {
			command: string;
			input: { Bucket: string; ExpectedBucketOwner?: string };
		}

		/**
		 * The S3 requests of the bucket step before a retry, for a destroy of STACKS. `before` holds
		 * each stack's CloudFormation events when the attempt began and `during` those the attempt
		 * added (both newest first); `after`, when given, is what the stack's events read as once
		 * the attempt failed, instead of `during` on top of `before`. Each bucket holds one object
		 * version. `account`: the verified account, `null` for none.
		 */
		async function s3Requests(
			before: Record<string, FakeEvent[] | Error>,
			during: Record<string, FakeEvent[]>,
			{ account = ACCOUNT, after }: { account?: string | null; after?: Record<string, FakeEvent[]> } = {},
		): Promise<S3Request[]> {
			const events: Record<string, FakeEvent[] | Error> = { ...before };
			const { cfn } = fakeCfn(events);
			const requests: S3Request[] = [];
			const listedOnce = new Set<string>();
			const s3 = {
				send: async (cmd: { constructor: { name: string }; input: { Bucket: string; ExpectedBucketOwner?: string } }) => {
					requests.push({ command: cmd.constructor.name, input: cmd.input });
					if (cmd.constructor.name !== 'ListObjectVersionsCommand' || listedOnce.has(cmd.input.Bucket)) return {};
					listedOnce.add(cmd.input.Bucket);
					return { Versions: [{ Key: 'object', VersionId: 'v1' }] };
				},
			} as unknown as S3Client;
			const deps = productionDestroyDeps(
				{ cdkAppPath: 'cdk.ts', projectRoot: '/app' },
				{},
				{ assemblyDir: '/app/.cdk-blocks-sandbox/destroy-x', stacks: STACKS, account: account ?? undefined },
				{ cfnFor: () => cfn, s3 },
			);
			const log = mock.method(console, 'log', () => {});
			try {
				await deps.beforeAttempt?.();
				for (const { stackName } of STACKS) {
					const earlier = before[stackName];
					events[stackName] = after?.[stackName] ?? [...(during[stackName] ?? []), ...(Array.isArray(earlier) ? earlier : [])];
				}
				await deps.emptyBuckets(STACKS);
			} finally {
				log.mock.restore();
			}
			return requests;
		}
		const emptied = (requests: S3Request[]) => [...new Set(requests.map((request) => request.input.Bucket))];

		// Functions: the suite's body runs before `at` below is initialized.
		// The deploy that the destroy starts from.
		const deployed = (stack: string): FakeEvent[] => [
			stackEvent(-900, stack, 'UPDATE_COMPLETE'),
			bucket(-905, 'SiteBucket', 'UPDATE_COMPLETE'),
			bucket(-906, 'ConfigLogsBucket', 'UPDATE_COMPLETE'),
		];
		// A delete of the app stack that began at `minute`: the site bucket could not be deleted
		// (`reason`), the config bucket is retained (CloudFormation skips it), and the stack failed.
		// Every event of one delete carries the ClientRequestToken of its DeleteStack call.
		const failedOnBucket = (minute = 1, reason = NOT_EMPTY, token = `delete-at-${minute}`): FakeEvent[] =>
			[
				stackEvent(minute + 19, 'app-prod', 'DELETE_FAILED'),
				bucket(minute + 5, 'SiteBucket', 'DELETE_FAILED', reason),
				bucket(minute + 4, 'ConfigLogsBucket', 'DELETE_SKIPPED'),
				event(minute + 3, 'AWS::Lambda::Function', 'Handler', 'DELETE_COMPLETE'),
				stackEvent(minute, 'app-prod', 'DELETE_IN_PROGRESS'),
			].map((ev) => ({ ...ev, ClientRequestToken: token }));
		const BEFORE = () => ({ 'app-prod': deployed('app-prod') });

		it('empties the bucket S3 refused to delete because it is not empty, and not the one the stack retains', async () => {
			const requests = await s3Requests(BEFORE(), { 'app-prod': failedOnBucket() });
			assert.deepStrictEqual(emptied(requests), ['sitebucket-physical']);
			assert.deepStrictEqual(
				requests.map((request) => request.command),
				['ListObjectVersionsCommand', 'DeleteObjectsCommand', 'ListObjectVersionsCommand'],
			);
			// Both requests name the verified account: S3 refuses them for a bucket of anyone else.
			for (const request of requests) assert.strictEqual(request.input.ExpectedBucketOwner, ACCOUNT, request.command);
		});

		it('empties nothing when the bucket could not be deleted for another reason', async () => {
			for (const reason of [
				'Access Denied (Service: S3, Status Code: 403, Request ID: x)',
				'Rate exceeded (Service: S3, Status Code: 503, Error Code: SlowDown)',
				undefined,
			]) {
				const during = failedOnBucket();
				during[1].ResourceStatusReason = reason;
				assert.deepStrictEqual(await s3Requests(BEFORE(), { 'app-prod': during }), [], String(reason));
			}
		});

		it('ignores a bucket that an earlier attempt could not delete, however recent', async () => {
			// The previous attempt began 30 seconds before this one and failed on the bucket.
			const before = { 'app-prod': [...failedOnBucket(-0.5), ...deployed('app-prod')] };
			// This attempt never reached the stack.
			assert.deepStrictEqual(await s3Requests(before, {}), []);
			// This attempt deleted the stack's resources and failed on something else.
			const thenAnother = [
				stackEvent(20, 'app-prod', 'DELETE_FAILED'),
				event(5, 'AWS::ApiGateway::RestApi', 'Api', 'DELETE_FAILED'),
				stackEvent(1, 'app-prod', 'DELETE_IN_PROGRESS'),
			];
			assert.deepStrictEqual(await s3Requests(before, { 'app-prod': thenAnother }), []);
		});

		it('empties nothing without a delete of the stack begun in this attempt', async () => {
			// A bucket event with no DELETE_IN_PROGRESS of the stack after the snapshot.
			assert.deepStrictEqual(await s3Requests(BEFORE(), { 'app-prod': failedOnBucket().slice(0, -1) }), []);
		});

		it('empties nothing for a bucket failure of another operation than the delete this attempt began', async () => {
			// An operation begun before the snapshot was still finishing: its bucket failure lands
			// after the snapshot, on either side of this attempt's DELETE_IN_PROGRESS.
			const lateFailure = (minute: number) => ({ ...bucket(minute, 'DataBucket', 'DELETE_FAILED'), ClientRequestToken: 'earlier-operation' });
			const [failed, site, ...rest] = failedOnBucket();
			const mixed = [failed, lateFailure(8), site, ...rest, lateFailure(0.5)];
			assert.deepStrictEqual(emptied(await s3Requests(BEFORE(), { 'app-prod': mixed })), ['sitebucket-physical']);
			// Events without a request token prove nothing.
			const untokened = failedOnBucket().map((ev) => ({ ...ev, ClientRequestToken: undefined }));
			assert.deepStrictEqual(await s3Requests(BEFORE(), { 'app-prod': untokened }), []);
		});

		it('empties nothing when the events from before the attempt could not be read, or are not found again', async () => {
			assert.deepStrictEqual(await s3Requests({ 'app-prod': new Error('Rate exceeded') }, { 'app-prod': failedOnBucket() }), []);
			// A stack with no event before the attempt.
			assert.deepStrictEqual(await s3Requests({}, { 'app-prod': failedOnBucket() }), []);
			// The newest event from before the attempt is not among the stack's events afterwards.
			assert.deepStrictEqual(await s3Requests(BEFORE(), {}, { after: { 'app-prod': failedOnBucket() } }), []);
		});

		it('empties nothing in the app stack when the monitoring stack failed and the app stack was not reached', async () => {
			const monitoring = 'app-prod-CfMonitoring-0a1b2c3d';
			const requests = await s3Requests(
				{ ...BEFORE(), [monitoring]: [stackEvent(-890, monitoring, 'CREATE_COMPLETE')] },
				{
					// CDK deletes the monitoring stack first; it was throttled, and the destroy stopped there.
					[monitoring]: [
						stackEvent(20, monitoring, 'DELETE_FAILED'),
						event(5, 'AWS::CloudWatch::Alarm', 'CloudFront5xxRate', 'DELETE_FAILED', undefined, THROTTLE),
						stackEvent(1, monitoring, 'DELETE_IN_PROGRESS'),
					],
				},
			);
			assert.deepStrictEqual(requests, []);
		});

		it('empties nothing without a verified account, whatever the events say', async () => {
			assert.deepStrictEqual(await s3Requests(BEFORE(), { 'app-prod': failedOnBucket() }, { account: null }), []);
		});

		it('the sandbox destroy still empties every bucket of its stacks, naming the verified account', async () => {
			const requests: Array<{ command: string; input: { Bucket: string; ExpectedBucketOwner?: string } }> = [];
			const cfn = {
				send: async (cmd: { constructor: { name: string } }) => {
					assert.strictEqual(cmd.constructor.name, 'ListStackResourcesCommand');
					return {
						StackResourceSummaries: [
							{ ResourceType: 'AWS::S3::Bucket', PhysicalResourceId: 'site-bucket' },
							// Retained by the stack: a sandbox is disposable, so it is emptied all the same.
							{ ResourceType: 'AWS::S3::Bucket', PhysicalResourceId: 'retained-bucket' },
						],
					};
				},
			} as unknown as CloudFormationClient;
			const s3 = {
				send: async (cmd: { constructor: { name: string }; input: { Bucket: string; ExpectedBucketOwner?: string } }) => {
					requests.push({ command: cmd.constructor.name, input: cmd.input });
					return {};
				},
			} as unknown as S3Client;
			const deps = sandboxDestroyDeps('/app/cdk-blocks/index.ts', {}, { cfnFor: () => cfn, s3 }, undefined, ACCOUNT);
			await deps.emptyBuckets([{ stackName: 'app-jdoe', region: 'eu-west-1' }]);
			assert.deepStrictEqual(emptied(requests), ['site-bucket', 'retained-bucket']);
			for (const request of requests) assert.strictEqual(request.input.ExpectedBucketOwner, ACCOUNT);
		});
	});

	it('destroyWasThrottled returns false for no stacks and calls no AWS API', async () => {
		const { CloudFormationClient } = await import('@aws-sdk/client-cloudformation');
		const send = mock.method(CloudFormationClient.prototype, 'send', async () => {
			throw new Error('must not call AWS');
		});
		try {
			assert.strictEqual(await destroyWasThrottled([], 0), false);
			assert.strictEqual(send.mock.callCount(), 0);
		} finally {
			send.mock.restore();
		}
	});
});

describe('isThrottleReason', () => {
	it('matches the throttle reasons seen on DELETE_FAILED / CREATE_FAILED', () => {
		assert.ok(
			isThrottleReason(
				'Too Many Requests (Service: ApiGateway, Status Code: 429, Request ID: 1390791a) (SDK Attempt Count: 5)',
			),
		);
		assert.ok(
			isThrottleReason('Rate exceeded (Service: AmazonCloudFormation; Status Code: 400; Error Code: Throttling)'),
		);
		assert.ok(isThrottleReason('TooManyRequestsException: Too many requests'));
		assert.ok(isThrottleReason('Rate Exceeded. (Service: Lambda, Error Code: TooManyRequestsException)'));
		assert.ok(
			isThrottleReason(
				'Request limit exceeded. (Service: Ec2, Status Code: 503, Error Code: RequestLimitExceeded)',
			),
		);
		assert.ok(
			isThrottleReason('Please reduce your request rate. (Service: S3, Status Code: 503, Error Code: SlowDown)'),
		);
	});

	it('does not match ordinary teardown failures', () => {
		assert.ok(!isThrottleReason(undefined));
		// A resource whose name contains "throttling" is not a throttle.
		assert.ok(!isThrottleReason('The following resource(s) failed to delete: [ApiThrottlingPlan1A2B3C]. '));
		assert.ok(!isThrottleReason('Role my-app-throttling-role is in use'));
		assert.ok(!isThrottleReason('The following resource(s) failed to delete: [DefaultComputeAPI5E5CE44A]. '));
		assert.ok(!isThrottleReason('The bucket you tried to delete is not empty'));
		assert.ok(!isThrottleReason('Network interface is currently in use'));
	});
});

type FakeEvent = {
	EventId?: string;
	ClientRequestToken?: string;
	Timestamp: Date;
	LogicalResourceId: string;
	PhysicalResourceId?: string;
	ResourceType: string;
	ResourceStatus: string;
	ResourceStatusReason?: string;
};

/** Fake CFN client serving DescribeStackEvents newest-first, `pageSize` events per page. */
function fakeCfn(eventsByStack: Record<string, FakeEvent[] | Error>, pageSize = 100) {
	const calls: string[] = [];
	const send = async (cmd: { constructor: { name: string }; input: { StackName: string; NextToken?: string } }) => {
		if (cmd.constructor.name !== 'DescribeStackEventsCommand')
			throw new Error(`unexpected ${cmd.constructor.name}`);
		const { StackName, NextToken } = cmd.input;
		calls.push(`${StackName}:${NextToken ?? 0}`);
		const events = eventsByStack[StackName];
		if (events instanceof Error) throw events;
		const start = Number(NextToken ?? 0);
		const page = (events ?? []).slice(start, start + pageSize);
		const next = start + pageSize < (events ?? []).length ? String(start + pageSize) : undefined;
		return { StackEvents: page, NextToken: next };
	};
	return { cfn: { send } as unknown as CloudFormationClient, calls };
}

const at = (min: number) => new Date(Date.UTC(2026, 9, 22, 11, 0) + min * MIN);
const SINCE = at(0).getTime();

/** Events of one delete attempt that began at `startMin`, newest-first (the order CFN returns). */
function attempt(stack: string, startMin: number, reason: string | undefined): FakeEvent[] {
	return [
		{
			Timestamp: at(startMin + 20),
			LogicalResourceId: stack,
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: 'DELETE_FAILED',
			ResourceStatusReason: 'The following resource(s) failed to delete: [DefaultComputeAPI5E5CE44A]. ',
		},
		{
			Timestamp: at(startMin + 5),
			LogicalResourceId: 'DefaultComputeAPI5E5CE44A',
			ResourceType: 'AWS::ApiGateway::RestApi',
			ResourceStatus: 'DELETE_FAILED',
			ResourceStatusReason: reason,
		},
		{
			Timestamp: at(startMin),
			LogicalResourceId: stack,
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: 'DELETE_IN_PROGRESS',
			ResourceStatusReason: 'User Initiated',
		},
	];
}

/**
 * Events of a previous attempt that began 55s before SINCE (inside the clock
 * skew window) and was throttled 30s before it; the attempt at SINCE never
 * reached DeleteStack. Newest-first.
 */
function shortPreviousAttempt(): FakeEvent[] {
	return [
		{
			Timestamp: new Date(SINCE - 30_000),
			LogicalResourceId: 'DefaultComputeAPI5E5CE44A',
			ResourceType: 'AWS::ApiGateway::RestApi',
			ResourceStatus: 'DELETE_FAILED',
			ResourceStatusReason: THROTTLE,
		},
		{
			Timestamp: new Date(SINCE - 55_000),
			LogicalResourceId: 's',
			ResourceType: 'AWS::CloudFormation::Stack',
			ResourceStatus: 'DELETE_IN_PROGRESS',
		},
	];
}

const THROTTLE = 'Too Many Requests (Service: ApiGateway, Status Code: 429, Request ID: x) (SDK Attempt Count: 5)';

describe('stackDeleteThrottled', () => {
	it('is true when this attempt failed a resource delete on a throttle', async () => {
		const { cfn } = fakeCfn({ s: attempt('s', 1, THROTTLE) });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), true);
	});

	it('is false when this attempt failed for another reason', async () => {
		const { cfn } = fakeCfn({ s: attempt('s', 1, 'Network interface is currently in use') });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('ignores a throttle from an earlier attempt (this attempt never started a delete)', async () => {
		// The only delete attempt is 30 min before this one began (e.g. cdk failed to synth).
		const { cfn } = fakeCfn({ s: attempt('s', -30, THROTTLE) });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('stops at the start of this attempt, so an older throttle does not leak in', async () => {
		const events = [...attempt('s', 10, 'Network interface is currently in use'), ...attempt('s', -10, THROTTLE)];
		const { cfn } = fakeCfn({ s: events });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('is true if any of several stacks was throttled; a stack that is gone is skipped', async () => {
		const { cfn } = fakeCfn({
			gone: new Error('Stack [gone] does not exist'),
			ok: attempt('ok', 1, 'Network interface is currently in use'),
			hot: attempt('hot', 2, THROTTLE),
		});
		assert.strictEqual(await stackDeleteThrottled(cfn, ['gone', 'ok', 'hot'], SINCE), true);
	});

	it('does not read a stack-level summary or nested stack as a throttle', async () => {
		const [stackFailed, , started] = attempt('s', 1, undefined);
		const events: FakeEvent[] = [
			{
				...stackFailed,
				ResourceStatusReason: 'The following resource(s) failed to delete: [Nested]. Throttling',
			},
			{
				Timestamp: at(4),
				LogicalResourceId: 'Nested',
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'DELETE_FAILED',
				ResourceStatusReason: THROTTLE,
			},
			{
				Timestamp: at(3),
				LogicalResourceId: 'Eni',
				ResourceType: 'AWS::EC2::NetworkInterface',
				ResourceStatus: 'DELETE_FAILED',
				ResourceStatusReason: 'Network interface is currently in use',
			},
			started,
		];
		const { cfn } = fakeCfn({ s: events });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('ignores a recent throttle (inside the clock-skew window) when this attempt never started a delete', async () => {
		// Previous attempt: began 6 min ago, RestApi throttled 50s ago. This attempt (at SINCE) never reached DeleteStack.
		const events: FakeEvent[] = [
			{
				Timestamp: new Date(SINCE - 45_000),
				LogicalResourceId: 's',
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'DELETE_FAILED',
			},
			{
				Timestamp: new Date(SINCE - 50_000),
				LogicalResourceId: 'DefaultComputeAPI5E5CE44A',
				ResourceType: 'AWS::ApiGateway::RestApi',
				ResourceStatus: 'DELETE_FAILED',
				ResourceStatusReason: THROTTLE,
			},
			{
				Timestamp: new Date(SINCE - 6 * MIN),
				LogicalResourceId: 's',
				ResourceType: 'AWS::CloudFormation::Stack',
				ResourceStatus: 'DELETE_IN_PROGRESS',
			},
		];
		const { cfn } = fakeCfn({ s: events });
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
	});

	it('throws a non-"does not exist" error after checking the other stacks', async () => {
		const denied = new Error('User is not authorized to perform: cloudformation:DescribeStackEvents');
		const { cfn, calls } = fakeCfn({ a: denied, b: attempt('b', 1, 'Network interface is currently in use') });
		await assert.rejects(stackDeleteThrottled(cfn, ['a', 'b'], SINCE), /not authorized/);
		assert.ok(
			calls.some((c) => c.startsWith('b:')),
			'still checked stack b',
		);
		// ...but a throttle found on another stack wins over the error.
		const hot = fakeCfn({ a: denied, b: attempt('b', 1, THROTTLE) });
		assert.strictEqual(await stackDeleteThrottled(hot.cfn, ['a', 'b'], SINCE), true);
	});

	it("ignores the previous attempt's events when that attempt was short (notBeforeMs)", async () => {
		// Previous attempt began 55s ago (inside the skew window) and was throttled 30s ago;
		// this attempt (at SINCE) never reached DeleteStack, and the previous one failed 20s ago.
		const events = shortPreviousAttempt();
		const { cfn } = fakeCfn({ s: events });
		assert.strictEqual(
			await stackDeleteThrottled(cfn, ['s'], SINCE),
			true,
			'without notBeforeMs the skew window lets it in',
		);
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE, SINCE - 20_000), false);
	});

	it("looks each stack up in its own Region when given a client per Region", async () => {
		const home: Record<string, string> = { app: 'eu-west-1', 'edge-lambda-stack-x': 'us-east-1' };
		const lookups: string[] = [];
		const cfnFor = (region: string | undefined) => {
			const { cfn } = fakeCfn({ 'edge-lambda-stack-x': attempt('edge-lambda-stack-x', 1, THROTTLE), app: [] });
			return {
				send: async (cmd: { constructor: { name: string }; input: { StackName: string } }) => {
					lookups.push(`${cmd.input.StackName}@${region}`);
					if (home[cmd.input.StackName] !== region) throw new Error(`Stack [${cmd.input.StackName}] does not exist`);
					return cfn.send(cmd as never);
				},
			} as unknown as CloudFormationClient;
		};
		const stacks = [
			{ stackName: 'app', region: 'eu-west-1' },
			{ stackName: 'edge-lambda-stack-x', region: 'us-east-1' },
		];
		assert.strictEqual(await stackDeleteThrottled(cfnFor, stacks, SINCE), true);
		assert.deepStrictEqual(lookups, ['app@eu-west-1', 'edge-lambda-stack-x@us-east-1']);
		assert.strictEqual(await destroyWasThrottled(stacks, SINCE, undefined, cfnFor), true);
	});

	it('throws when every stack is missing (e.g. stacks in another Region), so the caller warns', async () => {
		const { cfn } = fakeCfn({ a: new Error('Stack [a] does not exist'), b: new Error('Stack [b] does not exist') });
		await assert.rejects(stackDeleteThrottled(cfn, ['a', 'b'], SINCE), /none of the stacks/);
	});

	it('stops after a bounded number of pages', async () => {
		let pages = 0;
		const send = async () => {
			pages++;
			return {
				StackEvents: [
					{
						Timestamp: at(5),
						LogicalResourceId: 'Fn',
						ResourceType: 'AWS::Lambda::Function',
						ResourceStatus: 'DELETE_COMPLETE',
					},
				],
				NextToken: 'more',
			};
		};
		const cfn = { send } as unknown as CloudFormationClient;
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), false);
		assert.strictEqual(pages, 30);
	});

	it('follows pagination back to the start of this attempt', async () => {
		const filler: FakeEvent[] = Array.from({ length: 5 }, (_, i) => ({
			Timestamp: at(3),
			LogicalResourceId: `Fn${i}`,
			ResourceType: 'AWS::Lambda::Function',
			ResourceStatus: 'DELETE_COMPLETE',
		}));
		const [stackFailed, apiFailed, started] = attempt('s', 1, THROTTLE);
		const { cfn, calls } = fakeCfn({ s: [stackFailed, ...filler, apiFailed, started] }, 2);
		assert.strictEqual(await stackDeleteThrottled(cfn, ['s'], SINCE), true);
		assert.ok(calls.length > 1, `paginated: ${calls.join(' ')}`);
	});
});
