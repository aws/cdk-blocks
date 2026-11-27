// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type AssemblyStackNode, buildSandboxDeployArgs, cdkAppCommand } from './sandbox.js';
import { selectProductionStacks, stackExists } from './destroy.js';

// A destroy must select the stacks its deploy creates. With no selector,
// `cdk destroy` refuses an app with more than one top-level stack ("Since
// this app includes more than a single stack, specify which stacks to use ...
// or specify `--all`"), so an app deployed with `--all` (e.g. a Lambda@Edge
// `edge-lambda-stack-*` outside us-east-1, a `Vpc.fromLookup` reference stack,
// or Hosting's us-east-1 CloudFront monitoring stack) could never be destroyed.
// The sandbox destroy passes `--all`: a sandbox owns every stack it synthesizes.
// The production destroy names the app stack and its monitoring stack, and
// nothing else. The real destroy functions run in a child process against fake
// `npm`/`npx` binaries that record their argv, so no CDK or AWS call is made.
// The fakes are POSIX shell scripts (no `.cmd`).

const skip = process.platform === 'win32';
let root: string;
let argvLog: string;
let cdkLog: string;
let synthLog: string;

before(() => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), 'bb-destroy-select-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  argvLog = join(root, 'argv.log');
  cdkLog = join(root, 'cdk.log');
  synthLog = join(root, 'synth.log');
  for (const name of ['npm', 'npx']) {
    const file = join(bin, name);
    // Records its argv and, like CDK, writes a manifest into the `--output`
    // directory. cdk.log gets the working directory, the stage environment,
    // whether a stale file was still in that directory when it ran, and
    // whether the `--app` directory held an assembly.
    writeFileSync(
      file,
      // `cdk synth` (the production destroy's) writes the manifest in ZZ_MANIFEST
      // and records its argv and stage environment in synth.log, not in argv.log.
      `#!/bin/sh\nif [ "$2" = synth ]; then printf '%s\\n' "$@" "stage=$BLOCKS_STAGE mark=$ZZ_MARK" > "${synthLog}"\n` +
        `prev=\nfor a in "$@"; do if [ "$prev" = --output ]; then ` +
        `/bin/mkdir -p "$a" && printf '%s' "$ZZ_MANIFEST" > "$a/manifest.json"; fi; prev=$a; done\nexit 0\nfi\n` +
        `printf '%s\\n' "$@" > "${argvLog}"\necho "cwd=$PWD" > "${cdkLog}"\n` +
        `echo "stage=$BLOCKS_STAGE mark=$ZZ_MARK" >> "${cdkLog}"\necho "app=$BLOCKS_CDK_APP_ENTRY" >> "${cdkLog}"\n` +
        `prev=\nfor a in "$@"; do if [ "$prev" = --output ]; then ` +
        `if [ -e "$a/stale.json" ]; then echo stale-seen >> "${cdkLog}"; fi; ` +
        `/bin/mkdir -p "$a" && echo '{}' > "$a/manifest.json"; fi; ` +
        `if [ "$prev" = --app ] && [ -e "$a/manifest.json" ]; then echo assembly-seen >> "${cdkLog}"; fi; prev=$a; done\n` +
        // A destroy that can never succeed: the retry loop stops at once on this line.
        `if [ -n "$ZZ_FAIL_DESTROY" ]; then echo 'Error: Region is missing' >&2; exit 1; fi\n`,
    );
    chmodSync(file, 0o755);
  }
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Run `call` in a child ESM process with `mod` bound to `modulePath`; return the argv the fake binary recorded. */
function recordDestroyArgv(modulePath: string, call: string): string[] {
  rmSync(argvLog, { force: true });
  const moduleUrl = new URL(modulePath, import.meta.url).href;
  const script = `const mod = await import(${JSON.stringify(moduleUrl)}); await ${call};`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    // HOME without ~/.aws and no Region; the callers fake the credential check,
    // so the child never reaches AWS. PATH holds only the fake binaries.
    env: { PATH: join(root, 'bin'), HOME: root, USERPROFILE: root, CDK_DISABLE_CLI_TELEMETRY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return readFileSync(argvLog, 'utf-8').split('\n').filter(Boolean);
}

/**
 * `destroySandbox`'s body with the real cdk destroy (the fake npm binary) and retry, but no AWS:
 * no Region or credentials check, and no SSM delete (this app has no `.cdk-blocks/config.json`).
 */
const SANDBOX_DESTROY =
  "mod.runSandboxDestroy('cdk-blocks/index.ts', { checkCredentials: async () => {}, " +
  'retryClients: mod.destroyRetryClients, destroy: mod.runDestroyWithRetries, deleteSecrets: async () => [] })';

describe('destroy selects the stacks its deploy creates', { skip }, () => {
  it('destroySandbox runs `cdk destroy --all`, like the sandbox deploy', () => {
    const deployArgs = buildSandboxDeployArgs({ outDir: '.cdk-blocks-sandbox', projectRoot: '/app' });
    assert.ok(deployArgs.includes('--all'), `expected --all in the sandbox deploy: ${deployArgs.join(' ')}`);
    const argv = recordDestroyArgv('./sandbox.js', SANDBOX_DESTROY);
    assert.ok(argv.includes('destroy'), `expected a cdk destroy, got: ${argv.join(' ')}`);
    assert.ok(argv.includes('--all'), `expected --all in: ${argv.join(' ')}`);
    assert.ok(argv.includes('--force'), `expected --force in: ${argv.join(' ')}`);
    // sandboxMode=true keeps `--all --force` on this sandbox's stacks; without it the app names its stack `<app>-prod`.
    assert.strictEqual(argv[argv.indexOf('sandboxMode=true') - 1], '--context', `expected --context sandboxMode=true in: ${argv.join(' ')}`);
    // The same projectRoot as the sandbox deploy (the working directory), so both resolve the same stack names.
    const projectRoot = `projectRoot=${realpathSync(root)}`;
    assert.strictEqual(argv[argv.indexOf(projectRoot) - 1], '--context', `expected --context ${projectRoot} in: ${argv.join(' ')}`);
    // The retry reads the stacks this attempt selected from the assembly it synthesized.
    assert.strictEqual(argv[argv.indexOf('--output') + 1], '.cdk-blocks-sandbox/sandbox-destroy.out', `expected --output in: ${argv.join(' ')}`);
    // A destroy doesn't deploy the frontend, so Hosting reuses an existing build.
    assert.strictEqual(argv[argv.indexOf('reuseFrontendBuild=true') - 1], '--context', `expected --context reuseFrontendBuild=true in: ${argv.join(' ')}`);
    // The --app command names no path: the backend entry reaches CDK in its environment.
    assert.strictEqual(argv[argv.indexOf('--app') + 1], cdkAppCommand());
    assert.match(readFileSync(cdkLog, 'utf-8'), /^app=cdk-blocks\/index\.ts$/m);
  });

  it('destroySandbox clears a stale assembly first and removes the one CDK wrote after a successful destroy', () => {
    const assemblyDir = join(root, '.cdk-blocks-sandbox', 'sandbox-destroy.out');
    mkdirSync(assemblyDir, { recursive: true });
    writeFileSync(join(assemblyDir, 'stale.json'), '{}');
    const argv = recordDestroyArgv('./sandbox.js', SANDBOX_DESTROY);
    // CDK ran in the project root, where the relative `--output` and the cleanup point at the same directory ...
    assert.ok(argv.includes('.cdk-blocks-sandbox/sandbox-destroy.out'), argv.join(' '));
    const cdk = readFileSync(cdkLog, 'utf-8');
    assert.match(cdk, new RegExp(`^cwd=${realpathSync(root)}$`, 'm'));
    // ... the stale file was gone before CDK wrote there ...
    assert.doesNotMatch(cdk, /stale-seen/);
    // ... and the successful destroy removed what CDK wrote.
    assert.ok(!existsSync(assemblyDir), `expected ${assemblyDir} to be removed`);
  });
});

/** A stack artifact of a cloud assembly manifest; by default in 111111111111, the account the fake STS verifies. */
function stackArtifact(region: string, dependencies: string[] = [], stackName?: string, account = '111111111111') {
  return {
    type: 'aws:cloudformation:stack',
    environment: `aws://${account}/${region}`,
    dependencies,
    properties: { templateFile: 'stack.template.json', ...(stackName ? { stackName } : {}) },
  };
}

describe('the production destroy', { skip }, () => {
  /**
   * Loopback STS and CloudFormation: GetCallerIdentity succeeds; DescribeStacks knows
   * the stacks in `live`, whatever the Region, and records `<region>:<stack>` in `lookups`.
   */
  let server: Server;
  let endpoint: string;
  const live = new Set(['live-prod']);
  const lookups: string[] = [];
  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const stackName = params.get('StackName') ?? '';
        res.setHeader('content-type', 'text/xml');
        if (params.get('Action') === 'GetCallerIdentity') {
          res.end('<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::111111111111:user/u</Arn><Account>111111111111</Account></GetCallerIdentityResult></GetCallerIdentityResponse>');
          return;
        }
        // The Region is in the credential scope of the signature: Credential=<key>/<date>/<region>/<service>/aws4_request.
        lookups.push(`${/Credential=[^/]+\/\d+\/([^/]+)\//.exec(req.headers.authorization ?? '')?.[1]}:${stackName}`);
        if (live.has(stackName)) {
          res.end(`<DescribeStacksResponse><DescribeStacksResult><Stacks><member><StackName>${stackName}</StackName><StackStatus>UPDATE_COMPLETE</StackStatus><CreationTime>2026-01-01T00:00:00Z</CreationTime></member></Stacks></DescribeStacksResult></DescribeStacksResponse>`);
        } else {
          res.statusCode = 400;
          res.end(`<ErrorResponse><Error><Type>Sender</Type><Code>ValidationError</Code><Message>Stack with id ${stackName} does not exist</Message></Error></ErrorResponse>`);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** The assembly directories of production destroys still in the project. */
  const assemblyDirs = () => readdirSync(join(root, '.cdk-blocks-sandbox')).filter((name) => name.startsWith('destroy-'));
  /** The value of `flag` in a recorded argv. */
  const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  /**
   * Run the production destroy in a child, with a CDK app that synthesizes
   * `artifacts` (default: the one stack `stackName`, in us-east-1) and with
   * `deployed` as the stacks CloudFormation has; the server must keep
   * answering, so not execFileSync.
   */
  async function runDestroy(
    stackName: string,
    artifacts: Record<string, unknown> = { [stackName]: stackArtifact('us-east-1') },
    env: NodeJS.ProcessEnv = {},
    deployed: string[] = ['live-prod'],
  ): Promise<{ failed: boolean; output: string; cdkRan: boolean; argv: string[] }> {
    rmSync(argvLog, { force: true });
    rmSync(synthLog, { force: true });
    lookups.length = 0;
    live.clear();
    for (const stack of deployed) live.add(stack);
    const moduleUrl = new URL('./destroy.js', import.meta.url).href;
    const options = JSON.stringify({ cdkAppPath: 'cdk-blocks/index.cdk.ts', projectRoot: root, stackName });
    const script = `const mod = await import(${JSON.stringify(moduleUrl)}); await mod.destroy(${options});`;
    const run = promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      env: {
        PATH: join(root, 'bin'),
        HOME: root,
        CDK_DISABLE_CLI_TELEMETRY: '1',
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'AKIDTEST',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_ENDPOINT_URL_STS: endpoint,
        AWS_ENDPOINT_URL_CLOUDFORMATION: endpoint,
        ZZ_MANIFEST: JSON.stringify({ version: '36.0.0', artifacts }),
        ...env,
      },
      timeout: 60_000,
    });
    const { failed, stdout, stderr } = await run.then(
      (result) => ({ failed: false, ...result }),
      (error: { stdout: string; stderr: string }) => ({ failed: true, stdout: error.stdout, stderr: error.stderr }),
    );
    const cdkRan = existsSync(argvLog);
    const argv = cdkRan ? readFileSync(argvLog, 'utf-8').split('\n').filter(Boolean) : [];
    return { failed, output: `${stdout}${stderr}`, cdkRan, argv };
  }

  /** An app in eu-west-1 with Hosting's us-east-1 monitoring stack, a Lambda@Edge stack, a VPC lookup stack and an unrelated stack. */
  const hostedApp = (app: string) => ({
    [app]: stackArtifact('eu-west-1', [`${app}.assets`, 'edge-lambda-stack-c8', `${app}-vpc-ref`]),
    [`${app}.assets`]: { type: 'cdk:asset-manifest', properties: { file: `${app}.assets.json` } },
    [`${app}-CfMonitoring-0a1b2c3d`]: stackArtifact('us-east-1', [app]),
    'edge-lambda-stack-c8': stackArtifact('us-east-1'),
    [`${app}-vpc-ref`]: stackArtifact('eu-west-1'),
    'other-prod': stackArtifact('eu-west-1'),
  });
  const EU = { AWS_REGION: 'eu-west-1' };

  it('says there is nothing to delete, and runs no cdk destroy', async () => {
    const missing = await runDestroy('gone-prod');
    assert.strictEqual(missing.failed, false, missing.output);
    assert.match(missing.output, /There is no stack gone-prod in Region us-east-1; nothing to delete\./);
    assert.doesNotMatch(missing.output, /destroyed/);
    assert.strictEqual(missing.cdkRan, false);
    assert.deepStrictEqual(assemblyDirs(), [], 'the synthesized assembly is removed');
    const live = await runDestroy('live-prod');
    assert.strictEqual(live.cdkRan, true);
    assert.match(live.output, /Production stack destroyed/);
  });

  it('deletes the app stack and its CloudFront monitoring stack from the assembly it inspected, and nothing else', async () => {
    const run = await runDestroy('live-prod', hostedApp('live-prod'), EU, [
      'live-prod',
      'live-prod-CfMonitoring-0a1b2c3d',
      'edge-lambda-stack-c8',
      'other-prod',
    ]);
    assert.strictEqual(run.failed, false, run.output);
    // The assembly this destroy synthesized, then exactly the two stacks by id; no `--all`, and no
    // `--output` or `--context`, which would synthesize again. `--build=`: the CLI would run
    // cdk.json's build command again for an assembly, outside the synth lock.
    const assembly = valueOf(run.argv, '--app');
    assert.deepStrictEqual(run.argv, [
      'cdk',
      'destroy',
      '--app',
      assembly,
      '--build=',
      '--exclusively',
      'live-prod',
      'live-prod-CfMonitoring-0a1b2c3d',
      '--force',
    ]);
    assert.ok(assembly.startsWith(join(root, '.cdk-blocks-sandbox', 'destroy-')), assembly);
    // `cdk destroy` ran in the project root on the assembly the one synth wrote ...
    const cdk = readFileSync(cdkLog, 'utf-8');
    assert.match(cdk, new RegExp(`^cwd=${realpathSync(root)}$`, 'm'));
    assert.match(cdk, /^assembly-seen$/m);
    const synth = readFileSync(synthLog, 'utf-8').split('\n').filter(Boolean);
    assert.deepStrictEqual(synth.slice(0, 2), ['cdk', 'synth']);
    assert.strictEqual(valueOf(synth, '--output'), assembly);
    // ... which is removed once the stacks are gone.
    assert.deepStrictEqual(assemblyDirs(), [], 'the synthesized assembly is removed');
    // Each stack is looked up in its own Region, and the set is printed in the order CDK deletes it.
    assert.ok(lookups.includes('eu-west-1:live-prod'), lookups.join(' '));
    assert.ok(lookups.includes('us-east-1:live-prod-CfMonitoring-0a1b2c3d'), lookups.join(' '));
    assert.match(run.output, /Deleting live-prod-CfMonitoring-0a1b2c3d in Region us-east-1, then live-prod in Region eu-west-1/);
    assert.match(run.output, /Production stack destroyed/);
    // What the app stack depended on stays, and is reported with its Region and the command to delete it ...
    assert.match(run.output, /Not deleted: live-prod depended on this stack, which `npm run destroy` never deletes:/);
    assert.match(run.output, /^ {5}edge-lambda-stack-c8 in Region us-east-1$/m);
    assert.match(run.output, /^ {5}NODE_OPTIONS="--conditions=cdk" npx cdk destroy --exclusively edge-lambda-stack-c8$/m);
    // ... but not a lookup stack that was never deployed, nor a stack the app stack has nothing to do with.
    assert.doesNotMatch(run.output, /live-prod-vpc-ref|other-prod/);
  });

  it('synthesizes each destroy into its own directory, removed after a successful and after a failed destroy', async () => {
    const first = await runDestroy('live-prod');
    const second = await runDestroy('live-prod');
    assert.strictEqual(first.failed, false, first.output);
    assert.strictEqual(second.failed, false, second.output);
    // Two destroys of one checkout never share an assembly: neither can replace the one the other checked.
    assert.notStrictEqual(valueOf(first.argv, '--app'), valueOf(second.argv, '--app'));
    assert.deepStrictEqual(assemblyDirs(), []);
    // quiet: the retry loop reads the retained output, and stops at once on a failure no retry can fix.
    const failing = await runDestroy('live-prod', undefined, { ZZ_FAIL_DESTROY: '1', BLOCKS_LOG_LEVEL: 'quiet' });
    assert.strictEqual(failing.failed, true, failing.output);
    assert.strictEqual(failing.cdkRan, true);
    assert.match(failing.output, /Destroy failed: no AWS Region is set/);
    assert.ok(![valueOf(first.argv, '--app'), valueOf(second.argv, '--app')].includes(valueOf(failing.argv, '--app')));
    assert.deepStrictEqual(assemblyDirs(), [], 'the assembly of a failed destroy is removed too');
    // A refused selection never reaches cdk destroy, and leaves no assembly either.
    const refused = await runDestroy('live-prod', { 'my-blocks-stack-prod': stackArtifact('us-east-1') });
    assert.strictEqual(refused.failed, true);
    assert.deepStrictEqual(assemblyDirs(), []);
  });

  it('stops, and deletes nothing, when another stack depends on the app stack', async () => {
    const run = await runDestroy(
      'live-prod',
      {
        ...hostedApp('live-prod'),
        'reports-prod': stackArtifact('eu-west-1', ['live-prod']),
        // Named like a monitoring stack, but not in us-east-1: not Hosting's.
        'live-prod-CfMonitoring-9f8e7d6c': stackArtifact('eu-west-1', ['live-prod']),
      },
      EU,
    );
    assert.strictEqual(run.failed, true, run.output);
    assert.strictEqual(run.cdkRan, false);
    assert.match(
      run.output,
      /reports-prod, live-prod-CfMonitoring-9f8e7d6c depend on live-prod, and `npm run destroy` deletes only live-prod and the CloudFront monitoring stack that Hosting adds for it; nothing was deleted\. Delete reports-prod, live-prod-CfMonitoring-9f8e7d6c first, then re-run `npm run destroy`\./,
    );
    assert.deepStrictEqual(lookups, [], 'no stack is looked up once the selection is refused');
  });

  it('finishes a teardown that left the monitoring stack behind', async () => {
    const run = await runDestroy('half-prod', hostedApp('half-prod'), EU, ['half-prod-CfMonitoring-0a1b2c3d']);
    assert.strictEqual(run.failed, false, run.output);
    assert.match(
      run.output,
      /There is no stack half-prod in Region eu-west-1; deleting what is left of the app: half-prod-CfMonitoring-0a1b2c3d in Region us-east-1\./,
    );
    assert.deepStrictEqual(run.argv.slice(5), ['--exclusively', 'half-prod', 'half-prod-CfMonitoring-0a1b2c3d', '--force']);
    assert.match(run.output, /Production stack destroyed/);
  });

  it('says there is nothing to delete when neither the app stack nor its monitoring stack exists', async () => {
    const run = await runDestroy('gone-prod', hostedApp('gone-prod'), EU, ['edge-lambda-stack-c8', 'other-prod']);
    assert.strictEqual(run.failed, false, run.output);
    assert.match(
      run.output,
      /There is no stack gone-prod in Region eu-west-1, and no stack gone-prod-CfMonitoring-0a1b2c3d in Region us-east-1; nothing to delete\./,
    );
    assert.strictEqual(run.cdkRan, false);
    assert.deepStrictEqual(lookups.sort(), ['eu-west-1:gone-prod', 'us-east-1:gone-prod-CfMonitoring-0a1b2c3d']);
  });

  // The destroy's own lookups use the credentials CDK destroys with, in the account STS verified.
  // A stack name looked up for another account's stack would find a stack of this account, or
  // none, and "none" must not read as "nothing to delete".
  it('makes no AWS call of its own for a stack pinned to another account, and still hands it to cdk destroy', async () => {
    const run = await runDestroy('gone-prod', {
      'gone-prod': stackArtifact('us-east-1', ['shared-prod'], undefined, '222222222222'),
      'shared-prod': stackArtifact('us-east-1', [], undefined, '222222222222'),
    });
    assert.strictEqual(run.failed, false, run.output);
    assert.deepStrictEqual(lookups, []);
    assert.match(
      run.output,
      /Not looking up gone-prod \(account 222222222222\), shared-prod \(account 222222222222\), .*: these credentials are for account 111111111111\./,
    );
    assert.doesNotMatch(run.output, /nothing to delete/);
    assert.deepStrictEqual(run.argv.slice(5), ['--exclusively', 'gone-prod', '--force']);
    // The stack it depended on is unknown too, so it is listed as possibly still there.
    assert.match(run.output, /^ {5}shared-prod in Region us-east-1$/m);
  });

  it('makes no AWS call of its own when the account of the credentials could not be verified', async () => {
    // STS cannot be reached: the credential check warns and continues, as it always did.
    const run = await runDestroy('gone-prod', undefined, { AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:9' });
    assert.strictEqual(run.failed, false, run.output);
    assert.deepStrictEqual(lookups, []);
    assert.match(run.output, /Not looking up gone-prod \(account 111111111111\), .*: the AWS account of these credentials could not be verified\./);
    assert.doesNotMatch(run.output, /nothing to delete/);
    assert.strictEqual(run.cdkRan, true);
  });

  it('refuses, and deletes nothing, when the CDK app does not define the named stack', async () => {
    const other = await runDestroy('live-prod', { 'my-blocks-stack-prod': stackArtifact('us-east-1') });
    assert.strictEqual(other.failed, true);
    assert.strictEqual(other.cdkRan, false);
    assert.match(
      other.output,
      /The CDK app \(cdk-blocks\/index\.cdk\.ts\) defines my-blocks-stack-prod, not live-prod, the production stack that \.cdk-blocks\/config\.json names; nothing was deleted\./,
    );
    // A stack whose construct id differs from its name is selected by the id, which is what the CDK CLI matches.
    const named = await runDestroy('live-prod', {
      Edge: stackArtifact('us-east-1'),
      App: stackArtifact('us-east-1', [], 'live-prod'),
    });
    assert.strictEqual(named.cdkRan, true, named.output);
    assert.deepStrictEqual(named.argv.slice(5), ['--exclusively', 'App', '--force']);
  });

  it('does not synthesize while another command of the checkout does, and holds no lock afterwards', async () => {
    // A synth stages the frontend in directories the checkout shares: the lock of a command that
    // still runs (this test process plays it) stops the destroy before its synth.
    const lockFile = join(root, '.cdk-blocks-sandbox', 'synth.pid');
    const theirLock = JSON.stringify({ pid: process.pid, ppid: 1, port: 0, token: 'theirs', invocation: 'npm run deploy' });
    mkdirSync(join(root, '.cdk-blocks-sandbox'), { recursive: true });
    writeFileSync(lockFile, theirLock);
    try {
      const blocked = await runDestroy('live-prod');
      assert.strictEqual(blocked.failed, true, blocked.output);
      assert.match(blocked.output, new RegExp(`\`npm run deploy\` \\(pid ${process.pid}\\) is generating the client and synthesizing this app`));
      assert.ok(!existsSync(synthLog), 'no synth ran');
      assert.strictEqual(blocked.cdkRan, false);
      assert.strictEqual(readFileSync(lockFile, 'utf-8'), theirLock);
    } finally {
      rmSync(lockFile, { force: true });
    }
    // A destroy that runs takes the lock for its synth only, and releases it.
    const live = await runDestroy('live-prod');
    assert.strictEqual(live.failed, false, live.output);
    assert.ok(!existsSync(lockFile));
  });

  it('loads .env.production before the Region check, as the production deploy does', async () => {
    writeFileSync(join(root, '.env.production'), 'AWS_REGION=us-east-1\nZZ_MARK=from-env-production\n');
    try {
      const live = await runDestroy('live-prod', undefined, { AWS_REGION: undefined });
      assert.strictEqual(live.failed, false, live.output);
      const synth = readFileSync(synthLog, 'utf-8').split('\n').filter(Boolean);
      // A destroy doesn't deploy the frontend, so Hosting reuses an existing build.
      assert.strictEqual(synth[synth.indexOf('reuseFrontendBuild=true') - 1], '--context', `expected --context reuseFrontendBuild=true in: ${synth.join(' ')}`);
      assert.strictEqual(synth[synth.indexOf(`projectRoot=${root}`) - 1], '--context', `expected --context projectRoot in: ${synth.join(' ')}`);
      // The destroy synthesizes the app with the production environment.
      assert.ok(synth.includes('stage=production mark=from-env-production'), synth.join(' '));
    } finally {
      rmSync(join(root, '.env.production'), { force: true });
    }
  });

  it('reads only "does not exist" as a missing stack', async () => {
    const failing = (error: Error) => ({ send: async () => Promise.reject(error) });
    const named = (name: string, message: string) => Object.assign(new Error(message), { name });
    const describe = (name: string) => name;
    assert.strictEqual(await stackExists({ send: async () => ({}) }, describe, 's'), true);
    assert.strictEqual(await stackExists(failing(named('ValidationError', 'Stack with id s does not exist')), describe, 's'), false);
    assert.strictEqual(await stackExists(failing(named('AccessDenied', 'not authorized')), describe, 's'), undefined);
    assert.strictEqual(await stackExists(failing(named('ValidationError', 'Rate exceeded')), describe, 's'), undefined);
  });

  it('looks a deployed stack up with the deploy credentials, in the Region given or configured', async () => {
    const moduleUrl = new URL('./destroy.js', import.meta.url).href;
    const lookup = async (env: Record<string, string>, options: Record<string, unknown>) => {
      const script = `const mod = await import(${JSON.stringify(moduleUrl)}); console.log(String(await mod.deployedStackExists(${JSON.stringify({ projectRoot: root, ...options })})));`;
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
        cwd: root,
        env: { HOME: root, CDK_DISABLE_CLI_TELEMETRY: '1', ...env },
        timeout: 60_000,
      });
      return stdout.trim();
    };
    const aws = { AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'secret', AWS_ENDPOINT_URL_CLOUDFORMATION: endpoint };
    assert.strictEqual(await lookup({ ...aws, AWS_REGION: 'us-east-1' }, { stackName: 'live-prod' }), 'true');
    assert.strictEqual(await lookup({ ...aws, AWS_REGION: 'us-east-1' }, { stackName: 'gone-prod' }), 'false');
    assert.strictEqual(await lookup(aws, { stackName: 'gone-prod', region: 'eu-west-1' }), 'false');
    // No Region to look in, or a lookup that fails otherwise: unknown.
    assert.strictEqual(await lookup(aws, { stackName: 'live-prod' }), 'undefined');
    const unreachable = { ...aws, AWS_ENDPOINT_URL_CLOUDFORMATION: 'http://127.0.0.1:9', AWS_REGION: 'us-east-1' };
    assert.strictEqual(await lookup(unreachable, { stackName: 'live-prod' }), 'undefined');
  });
});

describe('selectProductionStacks', () => {
  const node = (id: string, region: string | undefined, dependencies: string[] = [], stackName = id): AssemblyStackNode => ({
    id,
    selector: id,
    stackName,
    region,
    account: region ? '111111111111' : undefined,
    dependencies,
  });
  const app = node('zz-prod', 'eu-west-1', ['edge-lambda-stack-c8']);
  const monitoring = node('zz-prod-CfMonitoring-0a1b2c3d', 'us-east-1', ['zz-prod']);
  const edge = node('edge-lambda-stack-c8', 'us-east-1', ['shared']);
  const shared = node('shared', 'us-east-1');
  const unrelated = node('other-prod', 'eu-west-1');
  const ids = (stacks: AssemblyStackNode[]) => stacks.map((stack) => stack.id);

  it('selects the app stack and its monitoring stack, and leaves what the app stack depends on', () => {
    const selection = selectProductionStacks([unrelated, monitoring, shared, edge, app], 'zz-prod');
    assert.deepStrictEqual(ids(selection.stacks), ['zz-prod', 'zz-prod-CfMonitoring-0a1b2c3d']);
    // Also what it depends on through another stack.
    assert.deepStrictEqual(ids(selection.upstream).sort(), ['edge-lambda-stack-c8', 'shared']);
  });

  it('selects an environment-agnostic app stack on its own', () => {
    const selection = selectProductionStacks([node('zz-prod', undefined)], 'zz-prod');
    assert.deepStrictEqual(ids(selection.stacks), ['zz-prod']);
    assert.deepStrictEqual(selection.upstream, []);
  });

  it('does not select a stack that only has the name of a monitoring stack', () => {
    const lookalike = node('zz-prod-CfMonitoring-0a1b2c3d', 'us-east-1');
    assert.deepStrictEqual(ids(selectProductionStacks([app, edge, shared, lookalike], 'zz-prod').stacks), ['zz-prod']);
  });

  it('refuses a stack that depends on the app stack and is not its monitoring stack', () => {
    for (const [foreign, names] of [
      // Another app's stack that reads from this one.
      [[node('reports-prod', 'eu-west-1', ['zz-prod'])], 'reports-prod depends on zz-prod'],
      // The monitoring name, outside us-east-1 or without the 8 hex digits.
      [[node('zz-prod-CfMonitoring-0a1b2c3d', 'eu-west-1', ['zz-prod'])], 'zz-prod-CfMonitoring-0a1b2c3d depends on zz-prod'],
      [[node('zz-prod-CfMonitoring-custom', 'us-east-1', ['zz-prod'])], 'zz-prod-CfMonitoring-custom depends on zz-prod'],
      // A stack that depends on the monitoring stack, so on the app stack through it.
      [[monitoring, node('dash', 'us-east-1', ['zz-prod-CfMonitoring-0a1b2c3d'])], 'dash depends on zz-prod'],
    ] as const) {
      assert.throws(
        () => selectProductionStacks([app, edge, shared, ...foreign], 'zz-prod'),
        (error: Error) => error.message.startsWith(`${names}, and \`npm run destroy\` deletes only zz-prod`) && /nothing was deleted/.test(error.message),
        names,
      );
    }
  });

  it('names the invocation the user ran', () => {
    assert.throws(
      () => selectProductionStacks([app, edge, shared, node('reports-prod', 'eu-west-1', ['zz-prod'])], 'zz-prod', 'npm run destroy -- --yes'),
      /Delete reports-prod first, then re-run `npm run destroy -- --yes`\./,
    );
  });

  it('refuses an app that does not define the named stack, listing its stacks as `cdk ls` does', () => {
    assert.throws(
      () => selectProductionStacks([node('Main', 'eu-west-1', [], 'zz-app-prod-main'), unrelated], 'zz-prod'),
      /defines Main \(zz-app-prod-main\), other-prod, not zz-prod, the production stack that \.cdk-blocks\/config\.json names; nothing was deleted\./,
    );
    assert.throws(() => selectProductionStacks([], 'zz-prod'), /defines no stack, not zz-prod/);
  });

  it('refuses two stacks with the production stack name', () => {
    assert.throws(
      () => selectProductionStacks([node('Eu', 'eu-west-1', [], 'zz-prod'), node('Us', 'us-east-1', [], 'zz-prod')], 'zz-prod'),
      /defines 2 stacks named zz-prod \(Eu in eu-west-1, Us in us-east-1\).*nothing was deleted/,
    );
  });

  it('without a stack name, selects the only stack of the app and refuses any other app', () => {
    assert.deepStrictEqual(ids(selectProductionStacks([unrelated], undefined).stacks), ['other-prod']);
    assert.throws(
      () => selectProductionStacks([app, monitoring, edge, shared], undefined),
      /was not given the production stack to delete; nothing was deleted\. Pass `stackName` to destroy\(\)\./,
    );
    assert.throws(() => selectProductionStacks([], undefined), /defines no stack, and the destroy was not given/);
  });

  it('refuses a stack id that the CDK CLI would read as a pattern', () => {
    assert.throws(
      () => selectProductionStacks([node('zz-*', 'eu-west-1', [], 'zz-prod'), unrelated], 'zz-prod'),
      /can't select zz-\* \(zz-prod\).*nothing was deleted/,
    );
  });
});
