// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { attachCdkWatchOutput } from './cdk-output.js';
import type { CredentialFailureInText } from './credential-guidance.js';
import type { OutputSink } from './deploy-stream.js';
import type { BlocksLogLevel } from './log.js';
import {
	createCdkWatchObserver,
	createSandboxDeployObserver,
	sandboxCredentialFailureMessage,
	sandboxDenialRecoveryHint,
	sandboxDeniedFailureHint,
	sandboxFailureHint,
	sandboxFailureKind,
	sandboxFailureRecoveryHint,
} from './sandbox.js';

// CDK CLI output of a sandbox deploy (`--method direct --express`, no `--ci`, so
// everything is on stderr) that an SCP stopped at `cloudformation:CreateStack`,
// with identifiers replaced by documented example values.
const STACK = 'my-app-a1b2c3-user-x1y2z3';
const DEPLOY_ROLE =
	'arn:aws:sts::123456789012:assumed-role/cdk-hnb659fds-deploy-role-123456789012-us-east-1/aws-cdk-user';
const SCP_ARN = 'arn:aws:organizations::777788889999:policy/o-exampleorgid/service_control_policy/p-examplepolicyid123';
const CREATE_STACK_DENIED = [
	`${STACK}: deploying... [1/1]`,
	// The CDK CLI prints the stack name in bold in a terminal.
	`\u001b[1m${STACK}\u001b[22m: creating stack...`,
	`❌  ${STACK} failed to deploy`,
	`‣ AccessDenied: User: ${DEPLOY_ROLE} is not authorized to perform: cloudformation:CreateStack on resource: arn:aws:cloudformation:us-east-1:123456789012:stack/${STACK}/* with an explicit deny in a service control policy: ${SCP_ARN}`,
	'',
];
const event = (status: string, type: string, id: string, reason = ''): string =>
	`${STACK} | 0/3 | 10:00:01 AM | ${status.padEnd(23)} | ${type.padEnd(36)} | ${id} ${reason}`;
const UPDATE_FAILED = [
	`${STACK}: deploying... [1/1]`,
	`${STACK}: updating stack...`,
	event('UPDATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
	event(
		'UPDATE_FAILED',
		'AWS::Lambda::Function',
		'Handler (Handler886CB40B)',
		'Resource handler returned message: "Unzipped size must be smaller than 262144000 bytes (Service: Lambda, Status Code: 400)"',
	),
	event(
		'UPDATE_FAILED',
		'AWS::CloudFormation::Stack',
		STACK,
		'The following resource(s) failed to update: [Handler886CB40B]',
	),
	`❌  ${STACK} failed to deploy`,
	'‣ DeploymentError: Resource updates failed:',
	'',
];
const UPDATE_DENIED = [
	`${STACK}: deploying... [1/1]`,
	`${STACK}: updating stack...`,
	event('UPDATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
	event(
		'CREATE_FAILED',
		'AWS::SQS::Queue',
		'Jobs (JobsQueue1A2B3C4D)',
		`Resource handler returned message: "User: ${DEPLOY_ROLE} is not authorized to perform: sqs:createqueue with an explicit deny in a service control policy"`,
	),
	event(
		'UPDATE_FAILED',
		'AWS::CloudFormation::Stack',
		STACK,
		'The following resource(s) failed to create: [JobsQueue1A2B3C4D]',
	),
	`❌  ${STACK} failed to deploy`,
	'',
];
const CREATE_FAILED = [
	`${STACK}: deploying... [1/1]`,
	`${STACK}: creating stack...`,
	event('CREATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
	event(
		'CREATE_FAILED',
		'AWS::S3::Bucket',
		'Assets (Assets1A2B3C4D)',
		'Resource handler returned message: "my-app-assets already exists (Service: S3, Status Code: 409)"',
	),
	event(
		'CREATE_FAILED',
		'AWS::CloudFormation::Stack',
		STACK,
		'The following resource(s) failed to create: [Assets1A2B3C4D]',
	),
	`❌  ${STACK} failed to deploy`,
	'',
];

function collectingSink(): OutputSink & { text(): string } {
	const chunks: string[] = [];
	return {
		write(chunk: string) {
			chunks.push(chunk);
			return true;
		},
		text: () => chunks.join(''),
	};
}

describe('createSandboxDeployObserver — the initial sandbox deploy’s output', () => {
	it('adds the notice right after the line that showed the deny, and nothing else', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		const denyAt = CREATE_STACK_DENIED.findIndex((line) => line.includes('with an explicit deny'));
		// The relay prints each line itself; the observer only reads it. CRLF as the CDK CLI writes on Windows.
		for (const line of CREATE_STACK_DENIED.slice(0, denyAt)) observer.line(`${line}\r`, 'stderr');
		assert.strictEqual(out.text(), '');
		observer.line(`${CREATE_STACK_DENIED[denyAt]}\r`, 'stderr');
		const notice = out.text();
		assert.match(notice, /^⚠️ {2}AWS denied a request during `npm run sandbox`[^\n]*\n[\s\S]*\n$/);
		assert.match(notice, /Signing in again or adding IAM permissions does not change that/);
		assert.doesNotMatch(notice, /123456789012|o-exampleorgid|p-examplepolicyid123/);
		for (const line of CREATE_STACK_DENIED.slice(denyAt + 1)) observer.line(`${line}\r`, 'stderr');
		observer.failed();
		assert.strictEqual(out.text(), notice, 'the deny is explained once');
		assert.strictEqual(observer.denied(), true);
	});

	it('reads the events that the CDK CLI prints to stdout with CI set', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		observer.line(
			event(
				'CREATE_FAILED',
				'AWS::ApiGateway::RestApi',
				'DefaultCompute/API (DefaultComputeAPI5E5CE44A)',
				`Resource handler returned message: "User: ${DEPLOY_ROLE} is not authorized to perform: apigateway:POST with an explicit deny in a service control policy"`,
			),
			'stdout',
		);
		assert.strictEqual(observer.denied(), true);
		assert.match(out.text(), /^⚠️ {2}AWS denied a request/);
	});

	it('adds nothing for progress with terminal control sequences, on success', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		observer.line(`\u001b[1m${STACK}\u001b[22m: deploying... [1/1]`, 'stderr');
		observer.line(`${event('CREATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK)}\r`, 'stderr');
		observer.line('\u001b[2K partial', 'stderr');
		assert.strictEqual(out.text(), '');
		assert.strictEqual(observer.denied(), false);
	});

	it('explains a denial without policy evidence once the deploy fails', () => {
		const out = collectingSink();
		const observer = createSandboxDeployObserver(out);
		observer.line(
			event('CREATE_FAILED', 'AWS::KMS::Key', 'Key', `Resource handler returned message: "Access denied for operation 'CreateKey'."`),
			'stderr',
		);
		assert.strictEqual(observer.denied(), false);
		observer.failed();
		assert.strictEqual(observer.denied(), true);
		assert.match(out.text(), /The credentials do not have the permissions/);
	});
});

describe('sandbox failure recovery — the Express Mode note only without a denial', () => {
	it('keeps the Express Mode recovery exactly as it was', () => {
		assert.strictEqual(
			sandboxFailureRecoveryHint(),
			[
				'',
				'ℹ️  Express Mode leaves failed sandbox stacks in place (automatic rollback is off).',
				'   If the next `npm run sandbox` reports the stack cannot be updated, recover with:',
				'',
				'     npm run sandbox:destroy   # tears the failed stack down (handles ROLLBACK_COMPLETE)',
				'     npm run sandbox           # redeploy from a clean slate',
				'',
				'   If destroy reports UPDATE_ROLLBACK_FAILED, first run:',
				'     aws cloudformation continue-update-rollback --stack-name <your-sandbox-stack>',
			].join('\n'),
		);
	});

	it('after a denial, says to run the sandbox again and suggests no destroy', () => {
		const hint = sandboxDenialRecoveryHint();
		assert.match(hint, /Run `npm run sandbox` again once the cause above is resolved/);
		assert.match(hint, /Do not destroy the sandbox to get past it: that deletes its data/);
		assert.doesNotMatch(hint, /sandbox:destroy|removes it|first deploy|Express Mode|limit|budget|spend|\d{12}|arn:/i);
		// The blocks CLI names its own commands.
		const cli = sandboxDenialRecoveryHint('cdk-blocks sandbox');
		assert.match(cli, /Run `cdk-blocks sandbox` again/);
		assert.doesNotMatch(cli, /npm run/);
	});

	it('after a denial, keeps the guidance of a known stack state, which suggests no destroy', () => {
		const args = [['my-sandbox'], 'cdk-blocks sandbox', 'cdk-blocks sandbox destroy'] as const;
		for (const kind of ['locked', 'in-progress', 'synth', 'healthy'] as const) {
			assert.strictEqual(sandboxDeniedFailureHint(kind, ...args), sandboxFailureHint(kind, ...args), kind);
		}
		// A locked output names the destroy command as a possible holder of the lock, not as a recovery.
		for (const kind of ['in-progress', 'synth', 'healthy'] as const) {
			assert.doesNotMatch(sandboxDeniedFailureHint(kind, ...args), /`cdk-blocks sandbox destroy`/, kind);
		}
		assert.match(sandboxDeniedFailureHint('healthy', ...args), /nothing to destroy/);
		assert.match(sandboxDeniedFailureHint('in-progress', ...args), /don't destroy the sandbox/);
	});

	it('after a denial, replaces the destroy advice of a failed or unread stack state', () => {
		const args = [['my-sandbox'], 'cdk-blocks sandbox', 'cdk-blocks sandbox destroy'] as const;
		for (const kind of ['failed-stack', 'unknown'] as const) {
			// Without a denial, these kinds get the destroy advice.
			assert.match(sandboxFailureHint(kind, ...args), /cdk-blocks sandbox destroy/, kind);
			const hint = sandboxDeniedFailureHint(kind, ...args);
			assert.strictEqual(hint, sandboxDenialRecoveryHint('cdk-blocks sandbox'), kind);
			assert.doesNotMatch(hint, /cdk-blocks sandbox destroy|removes it|first deploy|Express Mode leaves/, kind);
		}
	});

	it('after a denial, suggests no destroy when one stack failed and another could not be read', async () => {
		// The destroy command removes every stack of the sandbox, and nothing shows that the unread one is disposable.
		const statuses: Record<string, string | Error> = {
			'my-sandbox': 'UPDATE_FAILED',
			'my-sandbox-edge': new Error('AccessDenied: not authorized to perform: cloudformation:DescribeStacks'),
		};
		const kind = await sandboxFailureKind({
			phase: 'deploy',
			lines: [],
			stacks: Object.keys(statuses).map((stackName) => ({ stackName })),
			cfnFor: async () => () =>
				({
					send: async (command: { input: { StackName: string } }) => {
						const status = statuses[command.input.StackName];
						if (status instanceof Error) throw status;
						return { Stacks: [{ StackStatus: status }] };
					},
				}) as unknown as CloudFormationClient,
		});
		const hint = sandboxDeniedFailureHint(kind, Object.keys(statuses), 'npm run sandbox', 'npm run sandbox:destroy');
		assert.doesNotMatch(hint, /sandbox:destroy|removes it|first deploy/);
		assert.match(hint, /Run `npm run sandbox` again once the cause above is resolved/);
		assert.match(hint, /Do not destroy the sandbox/);
	});
});

describe('createCdkWatchObserver — `cdk watch` output, read through attachCdkWatchOutput', () => {
	afterEach(() => mock.restoreAll());
	/** A `cdk watch` output stream that delivers each write as one chunk, synchronously. */
	class FakeStream extends EventEmitter {
		setEncoding(): this {
			return this;
		}
		write(chunk: string): void {
			this.emit('data', chunk);
		}
		end(): void {
			this.emit('end');
		}
	}
	/** The sandbox's watch wiring: relayed through console.log/error, notices through console.error. */
	const watch = (level: BlocksLogLevel = 'legacy') => {
		const stdout = new FakeStream();
		const stderr = new FakeStream();
		const logs: string[] = [];
		const errors: string[] = [];
		mock.method(console, 'log', (text: string) => logs.push(text));
		mock.method(console, 'error', (text: string) => errors.push(text));
		const relay = createCdkWatchObserver({
			credentialMessage: async (failure: CredentialFailureInText) =>
				`CREDENTIALS ${failure.errorName} ${failure.failure}`,
		});
		const child = Object.assign(new EventEmitter(), { stdout, stderr }) as unknown as ChildProcess;
		attachCdkWatchOutput(child, {
			level,
			stderr: collectingSink(),
			onLine: (line, from) => relay.line(line, from),
		});
		const notices = () => errors.filter((e) => e.startsWith('⚠️  AWS denied')).length;
		const credentials = () => errors.filter((e) => e.startsWith('CREDENTIALS'));
		return { stdout, stderr, logs, errors, notices, credentials, relay };
	};
	const DENY = `‣ AccessDenied: User: ${DEPLOY_ROLE} is not authorized to perform: lambda:CreateFunction with an explicit deny in a service control policy`;

	it('relays output as before and explains a deny split across chunks', () => {
		const w = watch();
		w.stdout.write('[START RequestId: 1a2b] noise\n');
		w.stdout.write('watch: deploying\n');
		w.stderr.write("Triggering initial 'cdk deploy'\n");
		w.stderr.write(`❌  ${STACK} failed to deploy\n${DENY.slice(0, 80)}`);
		assert.strictEqual(w.notices(), 0);
		w.stderr.write(`${DENY.slice(80)}\r\n`);
		assert.deepStrictEqual(w.logs, ['[CDK Watch] watch: deploying'], 'Lambda request markers stay filtered');
		assert.strictEqual(w.errors[0], "[CDK Watch] Triggering initial 'cdk deploy'");
		assert.strictEqual(w.notices(), 1);
		assert.match(w.errors.at(-1) ?? '', /AWS Organizations policy/);
	});

	it('reads denial evidence on stdout too, with colors', () => {
		const w = watch();
		w.stdout.write(
			`\u001b[31m${event('CREATE_FAILED', 'AWS::SQS::Queue', 'Jobs', `"User: x is not authorized to perform: sqs:createqueue with an explicit deny in a resource control policy"`)}\u001b[39m\n`,
		);
		assert.strictEqual(w.notices(), 1);
	});

	it('explains repeated errors once per deployment, and again for the next deployment', () => {
		const w = watch();
		const failure = `❌  ${STACK} failed to deploy\n${DENY}\n\n`;
		w.stderr.write(`Triggering initial 'cdk deploy'\n${failure}${failure}`);
		w.stderr.write(failure);
		assert.strictEqual(w.notices(), 1);
		w.stderr.write(
			`Detected change to 'cdk-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n${failure}${failure}`,
		);
		assert.strictEqual(w.notices(), 2);
	});

	it('adds nothing for an ordinary failure during watch', async () => {
		const w = watch();
		w.stderr.write(`Triggering initial 'cdk deploy'\n${UPDATE_FAILED.join('\n')}`);
		w.stderr.end();
		await w.relay.idle();
		assert.strictEqual(w.notices(), 0);
		assert.deepStrictEqual(w.credentials(), []);
	});

	it('explains a credential failure in watch once per deployment, and never as a denial', async () => {
		const w = watch();
		w.stderr.write("Triggering initial 'cdk deploy'\n");
		// cdk watch prints a failed asset upload; a deploy error block is not printed in watch.
		w.stderr.write(`${STACK}: fail: The security token included in the request is expired\n`);
		w.stderr.write(`${STACK}: fail: Assuming role failed: ExpiredToken\n`);
		await w.relay.idle();
		assert.deepStrictEqual(w.credentials(), ['CREDENTIALS ExpiredToken expired'], 'once per deployment');
		assert.strictEqual(w.notices(), 0, 'an expired token is not a denial');
		assert.ok(
			w.errors.some((e) => e.includes('fail: The security token')),
			'the CDK output is still relayed',
		);
		w.stderr.write("Detected change to 'cdk-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n");
		w.stderr.write(
			`${STACK}: fail: The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.\n`,
		);
		await w.relay.idle();
		assert.deepStrictEqual(w.credentials(), [
			'CREDENTIALS ExpiredToken expired',
			'CREDENTIALS CredentialsProviderError expired',
		]);
		// A deny in the next deployment is still explained, without credential guidance.
		w.stderr.write(`Detected change to 'cdk-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n${DENY}\n`);
		await w.relay.idle();
		assert.strictEqual(w.notices(), 1);
		assert.strictEqual(w.credentials().length, 2);
	});

	it('ignores credential wording in app logs', async () => {
		const w = watch();
		w.stderr.write("Triggering initial 'cdk deploy'\n");
		w.stdout.write(
			'[/aws/lambda/handler] 10:00:00 AM ExpiredTokenException: The security token included in the request is expired\n',
		);
		await w.relay.idle();
		assert.deepStrictEqual(w.credentials(), []);
	});

	// The blocks CLI runs at `normal` by default and `quiet` with --quiet: the relay is curated there.
	for (const level of ['normal', 'quiet'] as const) {
		it(`explains a deny and a credential failure once per deployment at BLOCKS_LOG_LEVEL=${level}`, async () => {
			const w = watch(level);
			const failure = `❌  ${STACK} failed to deploy\n${DENY}\n\n`;
			w.stderr.write(`Triggering initial 'cdk deploy'\n${failure}${failure}`);
			assert.strictEqual(w.notices(), 1);
			assert.match(w.errors.find((e) => e.startsWith('⚠️  AWS denied')) ?? '', /during `npm run sandbox`/);
			w.stderr.write("Detected change to 'cdk-blocks/index.ts' (type: change). Triggering 'cdk deploy'\n");
			w.stderr.write(`${STACK}: fail: The security token included in the request is expired\n`);
			await w.relay.idle();
			assert.deepStrictEqual(w.credentials(), ['CREDENTIALS ExpiredToken expired']);
			assert.strictEqual(w.notices(), 1, 'an expired token is not a denial');
		});
	}

	it('names the command the user runs in the notice', () => {
		const errors: string[] = [];
		const observer = createCdkWatchObserver({ print: (text) => errors.push(text), invocation: 'cdk-blocks sandbox' });
		for (const line of ["Triggering initial 'cdk deploy'", `❌  ${STACK} failed to deploy`, DENY, '']) {
			observer.line(line, 'stderr');
		}
		assert.strictEqual(errors.length, 1);
		assert.match(errors[0], /^⚠️ {2}AWS denied a request during `cdk-blocks sandbox`\./);
	});
});

describe('sandboxCredentialFailureMessage — source-aware sign-in guidance', () => {
	const withConfig = async (config: string, env: NodeJS.ProcessEnv, watching: boolean) => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-credentials-'));
		try {
			writeFileSync(join(dir, 'config'), config);
			writeFileSync(join(dir, 'credentials'), '');
			return await sandboxCredentialFailureMessage(
				{ errorName: 'ExpiredToken', failure: 'expired' },
				{
					watching,
					projectRoot: dir,
					env: {
						AWS_CONFIG_FILE: join(dir, 'config'),
						AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials'),
						HOME: dir,
						...env,
					},
					readAwsCliVersion: async () => 'aws-cli/2.33.0 Python/3.12',
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const noIds = (message: string) => assert.doesNotMatch(message, /\d{12}|arn:|AKIA|secret-example/);

	it('tells an aws login profile to sign in again, then to save a file while watching', async () => {
		const message = await withConfig(
			'[profile dev]\nlogin_session = arn:aws:iam::123456789012:user/example\nregion = us-east-1\n',
			{ AWS_PROFILE: 'dev' },
			true,
		);
		assert.match(message, /aws login --profile dev/);
		assert.match(message, /save a file/);
		assert.doesNotMatch(message, /re-run `npm run sandbox`/);
		noIds(message);
	});

	const staticKeys = 'aws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret-example\n';
	const restart = /stop `npm run sandbox`[^\n]*run it again/;

	it('lets a role profile pick up new credentials on the next saved file', async () => {
		const message = await withConfig(
			`[profile dev]\nrole_arn = arn:aws:iam::123456789012:role/Deployer\nsource_profile = base\nregion = us-east-1\n[profile base]\n${staticKeys}`,
			{ AWS_PROFILE: 'dev' },
			true,
		);
		assert.match(message, /save a file/);
		assert.doesNotMatch(message, restart);
		noIds(message);
	});

	it('asks to restart the watch for direct profile keys and for credential_process', async () => {
		for (const profile of [staticKeys, 'credential_process = /usr/local/bin/print-credentials\n']) {
			const message = await withConfig(
				`[profile dev]\n${profile}region = us-east-1\n`,
				{ AWS_PROFILE: 'dev' },
				true,
			);
			assert.match(message, restart);
			noIds(message);
		}
	});

	it('tells an IAM Identity Center profile to run aws sso login', async () => {
		const message = await withConfig(
			'[profile dev]\nsso_session = corp\nsso_account_id = 123456789012\nsso_role_name = Developer\nregion = us-east-1\n',
			{ AWS_PROFILE: 'dev' },
			true,
		);
		assert.match(message, /aws sso login --profile dev/);
		noIds(message);
	});

	it('tells environment keys to export new ones and restart, which a running watch needs', async () => {
		const env = {
			AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
			AWS_SECRET_ACCESS_KEY: 'secret-example',
			AWS_REGION: 'us-east-1',
		};
		const watching = await withConfig('', env, true);
		assert.match(watching, /temporary credentials in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY have expired/);
		assert.match(watching, /stop `npm run sandbox`[^\n]*run it again/);
		noIds(watching);
		// Outside watch (the initial deploy), the command has stopped: re-run it.
		assert.match(await withConfig('', env, false), /Then re-run `npm run sandbox`\.$/);
	});
});

/**
 * The real `startSandbox({ deployOnly: true })` in a child process, offline, with
 * a fake `npm` that prints what the CDK CLI prints (see sandbox-telemetry.test.ts
 * for the fixture's design). The fake deploy writes its stderr in two chunks, in
 * the middle of a line, and records which stdin and stdout it was given.
 */
describe('startSandbox — the initial deploy’s output and failure guidance', () => {
	const distScripts = dirname(fileURLToPath(import.meta.url));
	const BACKEND_PATH = 'cdk-blocks/index.cdk.ts';
	let tmp: string;
	let appDir: string;

	const runSandbox = (
		stderrLines: string[],
		exitCode: number,
		stdoutLines = ['result from cdk on stdout'],
		extraEnv: NodeJS.ProcessEnv = {},
	) => {
		rmSync(join(appDir, '.cdk-blocks-sandbox'), { recursive: true, force: true });
		const name = `run-${Math.random().toString(36).slice(2)}`;
		const telemetryFile = join(tmp, `${name}-telemetry.json`);
		const env: NodeJS.ProcessEnv = {};
		for (const key of ['TMPDIR', 'USER', 'LANG']) if (process.env[key]) env[key] = process.env[key];
		Object.assign(env, {
			PATH: [join(tmp, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
			NODE_OPTIONS: '',
			HOME: join(tmp, 'home'),
			BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
			AWS_EC2_METADATA_DISABLED: 'true',
			AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
			FAKE_CDK_STDERR: stderrLines.join('\n'),
			FAKE_CDK_STDOUT: stdoutLines.map((line) => `${line}\n`).join(''),
			FAKE_CDK_EXIT: String(exitCode),
			...extraEnv,
		});
		const result = spawnSync(
			process.execPath,
			[join(tmp, 'run-sandbox.mjs'), `--telemetry-file=${telemetryFile}`],
			{
				cwd: appDir,
				env,
				encoding: 'utf-8',
				timeout: 60_000,
				killSignal: 'SIGKILL',
			},
		);
		return {
			status: result.status,
			stdout: String(result.stdout ?? ''),
			stderr: String(result.stderr ?? ''),
			telemetry: existsSync(telemetryFile) ? JSON.parse(readFileSync(telemetryFile, 'utf-8')) : [],
		};
	};

	before(() => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), 'blocks-sandbox-denial-')));
		appDir = join(tmp, 'app');
		mkdirSync(join(appDir, 'cdk-blocks'), { recursive: true });
		mkdirSync(join(tmp, 'home'), { recursive: true });
		writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module' }));
		mkdirSync(join(appDir, 'node_modules'));
		symlinkSync(
			dirname(fileURLToPath(import.meta.resolve('tsx/package.json'))),
			join(appDir, 'node_modules', 'tsx'),
		);
		writeFileSync(join(appDir, 'cdk-blocks', 'index.ts'), `export const api = { hello: async () => 'hi' };\n`);
		writeFileSync(join(appDir, BACKEND_PATH), `import './index.js';\n`);

		mkdirSync(join(tmp, 'bin'));
		writeFileSync(
			join(tmp, 'fake-npm.mjs'),
			`import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const argv = process.argv.slice(2);
if (argv[3] !== 'deploy') process.exit(0); // cdk synth
process.stdout.write(process.env.FAKE_CDK_STDOUT);
const text = process.env.FAKE_CDK_STDERR;
const cut = Math.floor(text.length / 2);
process.stderr.write(text.slice(0, cut));
// A real pause in the child, so that the parent reads two separate chunks.
setTimeout(() => {
  process.stderr.write(text.slice(cut));
  const code = Number(process.env.FAKE_CDK_EXIT);
  if (code === 0) {
    const outputs = argv[argv.indexOf('--outputs-file') + 1];
    mkdirSync(dirname(outputs), { recursive: true });
    writeFileSync(outputs, JSON.stringify({ 'fixture-stack': { ApiUrl: 'https://fake-api.example.com/' } }));
  }
  process.exitCode = code;
}, 50);
`,
		);
		writeFileSync(join(tmp, 'bin', 'npm'), `#!/bin/sh\nexec node "${join(tmp, 'fake-npm.mjs')}" "$@"\n`);
		chmodSync(join(tmp, 'bin', 'npm'), 0o755);
		writeFileSync(
			join(tmp, 'run-sandbox.mjs'),
			`import { startSandbox } from ${JSON.stringify(pathToFileURL(join(distScripts, 'sandbox.js')).href)};
try {
	// The blocks CLI passes its own commands for the guidance.
	const invocations = process.env.FAKE_INVOCATION
		? { invocation: process.env.FAKE_INVOCATION, destroyInvocation: process.env.FAKE_DESTROY_INVOCATION }
		: {};
	const apiUrl = await startSandbox({ backendPath: ${JSON.stringify(BACKEND_PATH)}, deployOnly: true, ...invocations });
	console.log('RETURNED ' + apiUrl);
} catch (e) {
	console.log('THREW ' + e.message);
}
`,
		);
	});

	after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// The fixture has no cloud assembly, so the stack state can't be read (`unknown`).
	const DENIAL_RECOVERY = 'ℹ️  Run `npm run sandbox` again once the cause above is resolved.';

	it('explains a CreateStack deny, suggests no destroy with an unread stack state and keeps the failure as it was', {
		timeout: 90_000,
	}, () => {
		const run = runSandbox(CREATE_STACK_DENIED, 1);
		const evidence = CREATE_STACK_DENIED[3];
		const at = (needle: string) => run.stderr.indexOf(needle);
		assert.ok(at(evidence) >= 0, run.stderr);
		assert.ok(at('⚠️  AWS denied a request during `npm run sandbox`') > at(evidence), run.stderr);
		assert.ok(at('❌ Deployment failed.') > at('AWS denied a request'), 'the explanation comes before the verdict');
		assert.ok(at(DENIAL_RECOVERY) > at('❌ Deployment failed.'), run.stderr);
		assert.doesNotMatch(run.stderr, /Express Mode leaves|sandbox:destroy|first deploy/);
		// Same error, exit and telemetry as before.
		assert.match(run.stdout, /THREW npm exec cdk -- deploy .* exited with code 1/);
		assert.deepStrictEqual(
			run.telemetry.map((e: { event: { state: string; error?: unknown } }) => [e.event.state, e.event.error]),
			[['FAIL', { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' }]],
		);
	});

	it('gives a denied update the same recovery, and an ordinary failure the Express Mode note', {
		timeout: 90_000,
	}, () => {
		const denied = runSandbox(UPDATE_DENIED, 1);
		assert.match(
			denied.stderr,
			/AWS denied a request[\s\S]*❌ Deployment failed\.\n\nℹ️ {2}Run `npm run sandbox` again once the cause/,
		);
		assert.doesNotMatch(denied.stderr, /Express Mode leaves|sandbox:destroy|first deploy/);
		// A stack whose name contains AccessDenied (stackId `AccessDenied`) is not a denial.
		const namedAccessDenied = [
			'AccessDenied-prod: deploying... [1/1]',
			'AccessDenied-prod: creating stack...',
			'AccessDenied-prod | 0/3 | 10:00:01 AM | CREATE_FAILED           | AWS::CloudFormation::Stack           | AccessDenied-prod The following resource(s) failed to create: [Assets1A2B3C4D]',
			'❌  AccessDenied-prod failed to deploy',
			'‣ ValidationError: Template format error: Unrecognized resource types: [AWS::Example::Thing]',
			'',
		];
		for (const lines of [UPDATE_FAILED, CREATE_FAILED, namedAccessDenied]) {
			const ordinary = runSandbox(lines, 1);
			assert.doesNotMatch(ordinary.stderr, /AWS denied a request/);
			assert.ok(
				ordinary.stderr.includes(`❌ Deployment failed.\n${sandboxFailureRecoveryHint()}\n`),
				ordinary.stderr,
			);
		}
	});

	it('explains a credential failure of the initial deploy for its source, before the verdict', {
		timeout: 90_000,
	}, () => {
		const run = runSandbox(
			[
				`❌  ${STACK} failed to deploy`,
				'‣ ExpiredToken: The security token included in the request is expired',
				'',
			],
			1,
			undefined,
			// Environment keys, and no Region, so the pre-deploy check is skipped as in the other runs.
			{ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret-example' },
		);
		const at = (needle: string) => run.stderr.indexOf(needle);
		assert.ok(at('AWS credentials could not be verified for `npm run sandbox` (ExpiredToken).') > 0, run.stderr);
		assert.match(run.stderr, /temporary credentials in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY have expired/);
		assert.ok(at('Then re-run `npm run sandbox`.') < at('❌ Deployment failed.'), run.stderr);
		assert.doesNotMatch(run.stderr, /AWS denied a request/);
		assert.ok(run.stderr.includes(`❌ Deployment failed.\n${sandboxFailureRecoveryHint()}\n`), run.stderr);
		assert.doesNotMatch(run.stderr.slice(at('AWS credentials could not be verified')), /AKIA|secret-example/);
	});

	it('in CI mode (events on stdout), explains the deny once, from the event or the error block', {
		timeout: 90_000,
	}, () => {
		// With CI set, the CDK CLI prints its progress to stdout, which is read too;
		// its error block still goes to stderr and repeats the deny.
		const deniedEvent = event(
			'CREATE_FAILED',
			'AWS::ApiGateway::RestApi',
			'DefaultCompute/API (DefaultComputeAPI5E5CE44A)',
			`Resource handler returned message: "User: ${DEPLOY_ROLE} is not authorized to perform: apigateway:POST with an explicit deny in a service control policy"`,
		);
		const errorBlock = [
			`❌  ${STACK} failed to deploy`,
			'‣ DeploymentError: Resource updates failed:',
			`${STACK}/DefaultCompute/API/Resource  (AWS::ApiGateway::RestApi DefaultComputeAPI5E5CE44A)`,
			'  Resource handler returned message: "User:',
			`  ${DEPLOY_ROLE} is not`,
			'  authorized to perform: apigateway:POST on resource: arn:aws:apigateway:us-east-1::/restapis with an explicit deny in a',
			`  service control policy: ${SCP_ARN}`,
			'  (Service: ApiGateway, Status Code: 403)"',
			'',
		];
		const run = runSandbox(errorBlock, 1, [`${STACK}: creating stack...`, deniedEvent, deniedEvent]);
		assert.ok(run.stdout.includes(deniedEvent), 'the events reach stdout unchanged');
		assert.doesNotMatch(run.stdout, /AWS denied a request/);
		assert.strictEqual(run.stderr.split('AWS denied a request').length - 1, 1, run.stderr);
		assert.ok(
			run.stderr.indexOf('AWS denied a request') < run.stderr.indexOf('❌ Deployment failed.'),
			run.stderr,
		);
		assert.match(run.stderr, /❌ Deployment failed\.\n\nℹ️ {2}Run `npm run sandbox` again once the cause/);
		assert.doesNotMatch(run.stderr, /Express Mode leaves|sandbox:destroy/);
	});

	it('keeps the guidance for a locked output after a deny, without the denial recovery', {
		timeout: 90_000,
	}, () => {
		// The lock is read from the retained output, which a curated level keeps.
		const run = runSandbox(
			[...CREATE_STACK_DENIED, 'Another CLI (PID=4242) is currently synthing to .cdk-blocks-sandbox/cdk.out', ''],
			1,
			undefined,
			{ BLOCKS_LOG_LEVEL: 'normal' },
		);
		assert.strictEqual(run.stderr.split('AWS denied a request').length - 1, 1, run.stderr);
		assert.ok(
			run.stderr.includes(`❌ Deployment failed.\n${sandboxFailureHint('locked')}\n`),
			run.stderr,
		);
		assert.doesNotMatch(run.stderr, /once the cause above is resolved|first deploy|Express Mode leaves/);
	});

	it('at the blocks CLI’s log levels, explains the deny once with its commands, before the verdict', {
		timeout: 180_000,
	}, () => {
		// The CLI sets BLOCKS_LOG_LEVEL (normal by default, quiet with --quiet, verbose with
		// --verbose) and BLOCKS_LOG_STREAM=stderr; quiet and normal curate the CDK output.
		for (const level of ['normal', 'quiet', 'verbose']) {
			const run = runSandbox(CREATE_STACK_DENIED, 1, undefined, {
				BLOCKS_LOG_LEVEL: level,
				BLOCKS_LOG_STREAM: 'stderr',
				FAKE_INVOCATION: 'cdk-blocks sandbox deploy',
				FAKE_DESTROY_INVOCATION: 'cdk-blocks sandbox destroy',
			});
			const at = (needle: string) => run.stderr.indexOf(needle);
			const notice = '⚠️  AWS denied a request during `cdk-blocks sandbox deploy`';
			assert.strictEqual(run.stderr.split('AWS denied a request').length - 1, 1, `${level}: ${run.stderr}`);
			assert.ok(at(notice) >= 0, `${level}: ${run.stderr}`);
			assert.match(run.stderr, /Signing in again or adding IAM permissions does not change that/);
			assert.ok(at('❌ Deployment failed.') > at(notice), `${level}: the explanation comes before the verdict`);
			assert.match(
				run.stderr,
				/❌ Deployment failed\.\n\nℹ️ {2}Run `cdk-blocks sandbox deploy` again once the cause above is resolved/,
			);
			assert.doesNotMatch(run.stderr, /Express Mode leaves|npm run sandbox|cdk-blocks sandbox destroy/);
			// The CDK CLI's evidence is still shown: as it arrives at verbose, and in the
			// retained output that quiet and normal print once the deploy has failed.
			assert.ok(run.stderr.includes(CREATE_STACK_DENIED[3]), `${level}: ${run.stderr}`);
			// Progress (here the fake CDK stdout) goes to stderr for the CLI; stdout keeps the result.
			assert.doesNotMatch(run.stdout, /AWS denied|result from cdk on stdout/);
			assert.match(run.stdout, /THREW npm exec cdk -- deploy .* exited with code 1/);
		}
	});

	it('streams the deploy output unchanged on both streams, and succeeds as before', {
		timeout: 90_000,
	}, () => {
		const progress = [
			`${STACK}: deploying... [1/1]`,
			`${STACK}: creating stack...`,
			event('CREATE_IN_PROGRESS', 'AWS::CloudFormation::Stack', STACK, 'User Initiated'),
			event('CREATE_COMPLETE', 'AWS::CloudFormation::Stack', STACK),
			'',
			` ✅  ${STACK}`,
		];
		const run = runSandbox(progress, 0);
		assert.strictEqual(run.status, 0, run.stderr);
		assert.ok(run.stderr.includes(progress.join('\n')), run.stderr);
		assert.doesNotMatch(run.stderr, /AWS denied|Deployment failed/);
		assert.match(
			run.stdout,
			/result from cdk on stdout[\s\S]*BLOCKS_DEPLOYED api=https:\/\/fake-api\.example\.com\//,
		);
	});
});
