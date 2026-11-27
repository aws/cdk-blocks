// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { AwsCredentialIdentity } from '@smithy/types';
import {
	type BootstrapTarget,
	type BootstrapVersionReader,
	type CdkBootstrapCheckOptions,
	assemblyBootstrapFailure,
	cdkBootstrapFailure,
} from './preflight-bootstrap.js';
import {
	type AssertAwsCredentialsOptions,
	type VerifiedDeploymentTarget,
	assertAwsCredentials,
} from './preflight-credentials.js';

const CREDENTIALS: AwsCredentialIdentity = { accessKeyId: 'AKIAEXAMPLEFIXTURE', secretAccessKey: 'fixture-secret' };
const ACCOUNT = '123456789012';

function namedError(name: string): Error {
	const err = new Error('raw sdk detail');
	err.name = name;
	return err;
}

/** A reader that records its calls and settles with `result`. */
function reader(result: () => Promise<unknown>) {
	const calls: [BootstrapTarget, string][] = [];
	const read: BootstrapVersionReader = async (target, name) => {
		calls.push([target, name]);
		return result();
	};
	return { read, calls };
}

const NOT_FOUND = async () => {
	throw namedError('ParameterNotFound');
};
const FOUND = async () => ({ Parameter: { Value: '30' } });

describe('CDK bootstrap check', () => {
	let directory: string;
	let env: NodeJS.ProcessEnv;
	let log: string[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'blocks-preflight-bootstrap-'));
		env = {
			HOME: directory,
			AWS_CONFIG_FILE: join(directory, 'config'),
			AWS_SHARED_CREDENTIALS_FILE: join(directory, 'credentials'),
			AWS_REGION: 'eu-south-2',
			AWS_PROFILE: 'starter',
		};
		await writeFile(join(directory, 'config'), '[profile starter]\nregion = eu-south-2\n');
		await writeFile(join(directory, 'credentials'), '');
		log = [];
		mock.method(console, 'log', (...args: unknown[]) => log.push(args.join(' ')));
		mock.method(console, 'warn', () => {});
	});

	afterEach(async () => {
		mock.restoreAll();
		await rm(directory, { recursive: true, force: true });
	});

	function check(
		read: BootstrapVersionReader,
		options: Partial<AssertAwsCredentialsOptions> = {},
	): Promise<VerifiedDeploymentTarget | undefined> {
		return assertAwsCredentials({
			command: 'deploy',
			env,
			projectRoot: directory,
			probe: async () => ({ credentials: CREDENTIALS, account: ACCOUNT }),
			metadataClients: async () => {
				throw new Error('no metadata in this test');
			},
			checkBootstrap: true,
			readBootstrapVersion: read,
			...options,
		});
	}

	async function failure(read: BootstrapVersionReader, options: Partial<AssertAwsCredentialsOptions> = {}) {
		const error = await check(read, options).then(
			() => assert.fail('expected the bootstrap check to stop the deploy'),
			(rejection: unknown) => rejection,
		);
		assert.ok(error instanceof Error);
		return error.message;
	}

	for (const command of ['deploy', 'sandbox']) {
		it(`stops ${command} with a ready-to-run bootstrap command when the version parameter is missing`, async () => {
			const { read, calls } = reader(NOT_FOUND);
			const message = await failure(read, { command });
			// The same Region, profile and verified credentials as the deploy, and the default qualifier.
			// The profile is AWS_PROFILE, which `--profile` sets (PN2): cdk.json selects none here.
			assert.deepEqual(calls, [
				[
					{ region: 'eu-south-2', profile: 'starter', credentials: CREDENTIALS },
					'/cdk-bootstrap/hnb659fds/version',
				],
			]);
			assert.match(message, /CDK is not bootstrapped in Region eu-south-2 of account 123456789012/);
			// `--app=` keeps `cdk bootstrap` from synthesizing the CDK Blocks app to find environments.
			assert.match(message, /^ {4}npx cdk bootstrap aws:\/\/123456789012\/eu-south-2 --app= --profile starter$/m);
			assert.match(message, new RegExp(`Then re-run \`npm run ${command}\`\\.$`));
			// The deployment target is printed before the deploy stops, so the user sees where it was going.
			assert.match(log.join('\n'), /Deployment target: AWS profile starter, Region eu-south-2/);
		});
	}

	it('names the command the user ran, when the caller passes it', async () => {
		const message = await failure(reader(NOT_FOUND).read, { invocation: 'npm run deploy -- --profile starter' });
		assert.match(message, /so `npm run deploy -- --profile starter` cannot deploy there/);
		assert.match(message, /Then re-run `npm run deploy -- --profile starter`\.$/);
		assert.doesNotMatch(message, /`npm run deploy`/);
	});

	it('prints no --profile when the deploy uses access keys from the environment', async () => {
		env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLE';
		env.AWS_SECRET_ACCESS_KEY = 'secret';
		const message = await failure(reader(NOT_FOUND).read);
		assert.match(message, /^ {4}npx cdk bootstrap aws:\/\/123456789012\/eu-south-2 --app=$/m);
	});

	it('checks the qualifier from the cdk.json context and passes the cdk.json profile', async () => {
		await writeFile(
			join(directory, 'cdk.json'),
			JSON.stringify({ profile: 'from-cdk', context: { '@aws-cdk/core:bootstrapQualifier': 'custom1' } }),
		);
		const { read, calls } = reader(NOT_FOUND);
		const message = await failure(read);
		assert.deepEqual(calls, [
			[{ region: 'eu-south-2', profile: 'from-cdk', credentials: CREDENTIALS }, '/cdk-bootstrap/custom1/version'],
		]);
		assert.match(message, /\/cdk-bootstrap\/custom1\/version not found/);
		// The user already set the qualifier where the check reads it.
		assert.doesNotMatch(message, /custom bootstrap qualifier/);
	});

	it('continues when the version parameter exists, and returns the account and the check that passed', async () => {
		const { read, calls } = reader(FOUND);
		const verified = await check(read);
		assert.equal(calls.length, 1);
		// What a deploy re-runs for the other Regions of its stacks, and a destroy binds its own AWS calls to.
		assert.equal(verified?.account, ACCOUNT);
		assert.equal(verified?.bootstrapCheck?.region, 'eu-south-2');
		assert.equal(verified?.bootstrapCheck?.account, ACCOUNT);
		assert.equal(verified?.bootstrapCheck?.credentials, CREDENTIALS);
		assert.equal(verified?.bootstrapCheck?.read, read);
	});

	for (const [name, result] of [
		['a denied read', async () => Promise.reject(namedError('AccessDeniedException'))],
		['a timeout', async () => Promise.reject(namedError('TimeoutError'))],
		['a network error', async () => Promise.reject(namedError('ECONNRESET'))],
		['a non-Error rejection', async () => Promise.reject('ParameterNotFound')],
	] as const) {
		it(`continues after ${name}, which does not prove that CDK is not bootstrapped`, async () => {
			const { read, calls } = reader(result);
			await check(read);
			assert.equal(calls.length, 1);
		});
	}

	it('skips the check when it is off, as for the destroy commands, and still returns the verified account', async () => {
		const { read, calls } = reader(NOT_FOUND);
		const verified = await check(read, { checkBootstrap: false, accountDetails: false });
		assert.equal(calls.length, 0);
		assert.deepEqual(verified, { account: ACCOUNT, bootstrapCheck: undefined });
	});

	it('skips the check when the credential check did not return an account, and returns nothing', async () => {
		const { read, calls } = reader(NOT_FOUND);
		assert.equal(await check(read, { probe: async () => ({ credentials: CREDENTIALS }) }), undefined);
		assert.equal(await check(read, { probe: async () => undefined }), undefined);
		assert.equal(calls.length, 0);
	});

	it('skips the check for a qualifier that the bootstrap template rejects, leaving the error to CDK', async () => {
		await writeFile(
			join(directory, 'cdk.json'),
			JSON.stringify({ context: { '@aws-cdk/core:bootstrapQualifier': 'has/slash' } }),
		);
		const { read, calls } = reader(NOT_FOUND);
		await check(read);
		assert.equal(calls.length, 0);
	});

	it('prints a placeholder instead of a Region that a shell could interpret', async () => {
		await writeFile(join(directory, 'cdk.json'), JSON.stringify({ region: 'eu-west-1$(touch x)' }));
		const message = await failure(reader(NOT_FOUND).read);
		assert.match(message, /^ {4}npx cdk bootstrap aws:\/\/123456789012\/<region> --app= --profile starter$/m);
		assert.doesNotMatch(message, /touch/);
	});
});

describe('cdkBootstrapFailure', () => {
	it('passes the profile the deploy used to the printed bootstrap command', async () => {
		const message = await cdkBootstrapFailure({
			invocation: 'npm run deploy -- --profile starter',
			account: '123456789012',
			region: 'eu-south-2',
			profile: 'starter',
			credentials: CREDENTIALS,
			read: reader(NOT_FOUND).read,
		});
		assert.match(String(message), /^ {4}npx cdk bootstrap aws:\/\/123456789012\/eu-south-2 --app= --profile starter$/m);
	});
});

describe('assemblyBootstrapFailure', () => {
	/** The check that passed in the configured Region; `read` answers per Region. */
	function checked(unbootstrapped: string[] = []) {
		const regions: string[] = [];
		const options: CdkBootstrapCheckOptions = {
			invocation: 'npm run deploy',
			account: ACCOUNT,
			region: 'eu-west-1',
			profile: 'starter',
			credentials: CREDENTIALS,
			qualifier: 'custom1',
			read: async (target, name) => {
				assert.deepEqual({ ...target, region: undefined }, { region: undefined, profile: 'starter', credentials: CREDENTIALS });
				assert.equal(name, '/cdk-bootstrap/custom1/version');
				regions.push(target.region);
				if (unbootstrapped.includes(target.region)) throw namedError('ParameterNotFound');
				return { Parameter: { Value: '30' } };
			},
		};
		return { options, regions };
	}
	// An app in eu-west-1 with Hosting's CloudFront monitoring stack in us-east-1.
	const TWO_REGIONS = [
		{ region: 'eu-west-1', account: ACCOUNT },
		{ region: 'us-east-1', account: ACCOUNT },
	];

	it('reports the Region of a stack outside the checked Region, with its bootstrap command', async () => {
		const { options, regions } = checked(['us-east-1']);
		const message = await assemblyBootstrapFailure(options, TWO_REGIONS);
		// The Region that the credential check covered is not read again.
		assert.deepEqual(regions, ['us-east-1']);
		assert.match(String(message), /^CDK is not bootstrapped in Region us-east-1 of account 123456789012, so `npm run deploy` cannot deploy there/);
		assert.match(String(message), /^ {4}npx cdk bootstrap aws:\/\/123456789012\/us-east-1 --app= --profile starter$/m);
		assert.doesNotMatch(String(message), /eu-west-1/);
	});

	it('passes when every Region is bootstrapped, reading each Region once', async () => {
		const { options, regions } = checked();
		const stacks = [...TWO_REGIONS, { region: 'us-east-1', account: ACCOUNT }, { region: 'ap-south-1', account: ACCOUNT }];
		assert.equal(await assemblyBootstrapFailure(options, stacks), undefined);
		assert.deepEqual(regions.sort(), ['ap-south-1', 'us-east-1']);
	});

	it('reports every Region without a bootstrap', async () => {
		const { options } = checked(['us-east-1', 'ap-south-1']);
		const message = await assemblyBootstrapFailure(options, [...TWO_REGIONS, { region: 'ap-south-1', account: ACCOUNT }]);
		assert.match(String(message), /aws:\/\/123456789012\/us-east-1 /);
		assert.match(String(message), /aws:\/\/123456789012\/ap-south-1 /);
	});

	it('reads nothing for an environment-agnostic app, which deploys to the checked Region', async () => {
		const { options, regions } = checked(['us-east-1']);
		assert.equal(await assemblyBootstrapFailure(options, [{}, { region: 'eu-west-1' }]), undefined);
		assert.deepEqual(regions, []);
	});

	it('skips a stack of another account, which these credentials cannot read', async () => {
		const { options, regions } = checked(['us-east-1']);
		assert.equal(await assemblyBootstrapFailure(options, [{ region: 'us-east-1', account: '999999999999' }]), undefined);
		assert.deepEqual(regions, []);
	});

	it('continues after an error that does not prove a missing bootstrap', async () => {
		const options: CdkBootstrapCheckOptions = {
			...checked().options,
			read: async () => {
				throw namedError('AccessDeniedException');
			},
		};
		assert.equal(await assemblyBootstrapFailure(options, TWO_REGIONS), undefined);
	});
});
