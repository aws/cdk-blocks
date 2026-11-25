// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
// Imported through `./deploy.js` ON PURPOSE: the helper is defined in
// deploy-stream.ts (and unit-tested there over its behaviour), but deploy.ts
// re-exports it as part of its public surface for external callers. This file
// guards that re-export — if the re-export is ever dropped, this import fails
// to resolve and the suite goes red. Its behavioural cases below double as a
// smoke test that the re-exported binding is the real function.
import {
  formatDeploySignal,
  parseWaitLiveArgs,
  DEFAULT_WAIT_LIVE_TIMEOUT_SEC,
  resolveHostingOutputs,
  parseInvalidationId,
  classifyInvalidationError,
  makeInvalidationProbe,
  type InvalidationStatusClient,
  publishAssembly,
} from './deploy.js';
import { OUTPUTS_FILE } from './deploy-outputs.js';

describe('formatDeploySignal — the machine-readable deploy completion line', () => {
  it('is re-exported by deploy.ts (the public surface external callers import)', () => {
    assert.strictEqual(typeof formatDeploySignal, 'function');
  });

  it('includes both the frontend url and the api when hosting is deployed', () => {
    const line = formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net');
    assert.strictEqual(line, 'BLOCKS_DEPLOYED url=https://app.cloudfront.net api=https://api.example.com');
  });

  it('omits url= for a backend-only deploy (no hosting)', () => {
    const line = formatDeploySignal('https://api.example.com');
    assert.strictEqual(line, 'BLOCKS_DEPLOYED api=https://api.example.com');
  });

  it('starts with the stable BLOCKS_DEPLOYED prefix so a caller can grep one line', () => {
    assert.match(formatDeploySignal('https://api.example.com'), /^BLOCKS_DEPLOYED /);
    assert.match(
      formatDeploySignal('https://api.example.com', 'https://app.cloudfront.net'),
      /^BLOCKS_DEPLOYED /,
    );
  });
});

describe('parseWaitLiveArgs — the --wait-live flag family', () => {
  it('defaults to not waiting when no flag is present', () => {
    const r = parseWaitLiveArgs(['--some-other-flag']);
    assert.strictEqual(r.waitLive, false);
    assert.strictEqual(r.waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('opts in on --wait-live with the default timeout', () => {
    const r = parseWaitLiveArgs(['--wait-live']);
    assert.strictEqual(r.waitLive, true);
    assert.strictEqual(r.waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('honors an explicit --wait-live-timeout=<seconds>', () => {
    const r = parseWaitLiveArgs(['--wait-live', '--wait-live-timeout=90']);
    assert.strictEqual(r.waitLive, true);
    assert.strictEqual(r.waitLiveTimeoutSec, 90);
  });

  it('floors a fractional timeout', () => {
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=12.9']).waitLiveTimeoutSec, 12);
  });

  it('falls back to the default on a non-numeric or out-of-range timeout (never fails the deploy)', () => {
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=abc']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=0']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=-5']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=99999']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });

  it('rejects a sub-1s fractional timeout (floors to 0) rather than a 0s budget', () => {
    // Floor happens BEFORE the range check, so 0.5 → 0 → out of range → default.
    assert.strictEqual(parseWaitLiveArgs(['--wait-live-timeout=0.5']).waitLiveTimeoutSec, DEFAULT_WAIT_LIVE_TIMEOUT_SEC);
  });
});

describe('resolveHostingOutputs — pairing the Hosting output group', () => {
  // Real CDK logical ids: a nested construct's CfnOutput id = <path><localId><8-hex-hash>.
  const single = {
    ApiUrl: 'https://api.example.com/prod/aws-blocks',
    HostingHostingUrl1A2B3C4D: 'https://d1.cloudfront.net',
    HostingHostingBuildId8EDD8441: 'build-abc',
    HostingHostingInvalidationIdF60AF4B3: 'DIST123/INV456',
  };

  it('pairs url, build id, and invalidation id from the same group', () => {
    const r = resolveHostingOutputs(single);
    assert.strictEqual(r.hostingUrl, 'https://d1.cloudfront.net');
    assert.strictEqual(r.expectedBuildId, 'build-abc');
    assert.strictEqual(r.invalidationId, 'DIST123/INV456');
  });

  it('omits the invalidation id for a pure-static deploy (no such output)', () => {
    const { HostingHostingInvalidationIdF60AF4B3: _omit, ...staticOutputs } = single;
    const r = resolveHostingOutputs(staticOutputs);
    assert.strictEqual(r.invalidationId, undefined);
    assert.strictEqual(r.expectedBuildId, 'build-abc');
  });

  it('falls back to the early stream url when no HostingUrl output is present', () => {
    const r = resolveHostingOutputs({ ApiUrl: 'https://api.example.com' }, 'https://early.cloudfront.net');
    assert.strictEqual(r.hostingUrl, 'https://early.cloudfront.net');
    assert.strictEqual(r.expectedBuildId, undefined);
  });

  it('does NOT cross groups on a two-Hosting stack (Web vs WebAdmin overlap)', () => {
    // `Web` is a prefix of `WebAdmin`; a loose startsWith would let the Web
    // group pick up WebAdmin's build id. The exact prefix + hex-tail match must
    // keep each group's ids with their own group.
    const two = {
      WebHostingUrl11111111: 'https://web.cloudfront.net',
      WebHostingBuildId22222222: 'web-build',
      WebHostingInvalidationId33333333: 'WDIST/WINV',
      WebAdminHostingUrl44444444: 'https://admin.cloudfront.net',
      WebAdminHostingBuildId55555555: 'admin-build',
      WebAdminHostingInvalidationId66666666: 'ADIST/AINV',
    };
    const r = resolveHostingOutputs(two);
    // The first Hosting group (Web) is the frontend --wait-live targets.
    assert.strictEqual(r.hostingUrl, 'https://web.cloudfront.net');
    assert.strictEqual(r.expectedBuildId, 'web-build');
    assert.strictEqual(r.invalidationId, 'WDIST/WINV');
  });
});

describe('parseInvalidationId — guarding the <distributionId>/<invalidationId> pair', () => {
  it('splits a well-formed pair', () => {
    assert.deepStrictEqual(parseInvalidationId('DIST123/INV456'), {
      distributionId: 'DIST123',
      invId: 'INV456',
    });
  });

  it('returns undefined for an absent id (pure-static deploy)', () => {
    assert.strictEqual(parseInvalidationId(undefined), undefined);
  });

  it('returns undefined for a malformed/empty pair so the wait degrades to config-only', () => {
    // Each would otherwise yield an undefined half and an opaque GetInvalidation error.
    assert.strictEqual(parseInvalidationId(''), undefined);
    assert.strictEqual(parseInvalidationId('DIST-only'), undefined);
    assert.strictEqual(parseInvalidationId('DIST/'), undefined);
    assert.strictEqual(parseInvalidationId('/INV'), undefined);
  });
});

describe('classifyInvalidationError — terminal vs transient', () => {
  const named = (name: string): Error => Object.assign(new Error(name), { name });

  it('classifies AccessDenied / AccessDeniedException as terminal', () => {
    assert.deepStrictEqual(classifyInvalidationError(named('AccessDenied')), { fatal: 'AccessDenied' });
    assert.deepStrictEqual(classifyInvalidationError(named('AccessDeniedException')), { fatal: 'AccessDeniedException' });
  });

  it('classifies NoSuchInvalidation / NoSuchDistribution as terminal', () => {
    assert.deepStrictEqual(classifyInvalidationError(named('NoSuchInvalidation')), { fatal: 'NoSuchInvalidation' });
    assert.deepStrictEqual(classifyInvalidationError(named('NoSuchDistribution')), { fatal: 'NoSuchDistribution' });
  });

  it('classifies a missing Region as terminal (SDK v3 clients do not read cdk.json)', () => {
    assert.deepStrictEqual(classifyInvalidationError(new Error('Region is missing')), { fatal: 'Region is missing' });
  });

  it('treats throttling / 5xx / timeout as transient (retry)', () => {
    assert.strictEqual(classifyInvalidationError(named('ThrottlingException')), 'transient');
    assert.strictEqual(classifyInvalidationError(named('InternalServerError')), 'transient');
    assert.strictEqual(classifyInvalidationError(named('TimeoutError')), 'transient');
  });
});

describe('makeInvalidationProbe — maps the SDK result to a pure outcome', () => {
  const cmd = (DistributionId: string, Id: string) => ({ DistributionId, Id });

  it("returns 'completed' once the invalidation reaches Completed", async () => {
    const client: InvalidationStatusClient = {
      async send() {
        return { Invalidation: { Status: 'Completed' } };
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.strictEqual(await probe(1000), 'completed');
  });

  it("returns 'pending' while still InProgress", async () => {
    const client: InvalidationStatusClient = {
      async send() {
        return { Invalidation: { Status: 'InProgress' } };
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.strictEqual(await probe(1000), 'pending');
  });

  it('maps a terminal SDK error to { fatal } (never a doomed retry)', async () => {
    const client: InvalidationStatusClient = {
      async send() {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.deepStrictEqual(await probe(1000), { fatal: 'AccessDenied' });
  });

  it("maps a transient SDK error to 'pending' (retry)", async () => {
    const client: InvalidationStatusClient = {
      async send() {
        throw Object.assign(new Error('ThrottlingException'), { name: 'ThrottlingException' });
      },
    };
    const probe = makeInvalidationProbe(client, cmd, 'DIST', 'INV');
    assert.strictEqual(await probe(1000), 'pending');
  });
});

describe('deploy — synth, bootstrap check, deploy', () => {
  // deploy() itself, in a fresh process. Only the steps that reach AWS or spawn
  // CDK are replaced; the fake CDK writes a cloud assembly manifest for `cdk
  // synth` and the production outputs document for `cdk deploy --outputs-file`.
  const scripts = new URL('./', import.meta.url).href;
  const prelude = `
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mock } from 'node:test';

const scripts = ${JSON.stringify(scripts)};
const moduleUrl = (name) => new URL(name + '.js', scripts).href;
const outputsFile = ${JSON.stringify(OUTPUTS_FILE.production)};
const prod = {
  ApiUrl: 'https://prod.execute-api.us-east-1.amazonaws.com/',
  HostingHostingUrl1A2B3C4D: 'https://d111.cloudfront.net',
  HostingHostingBuildId8EDD8441: 'build-1',
};
// An app in eu-west-1 with Hosting's CloudFront monitoring stack in us-east-1.
const stack = (region, dependencies = []) => ({
  type: 'aws:cloudformation:stack',
  environment: 'aws://111122223333/' + region,
  dependencies,
  properties: { templateFile: 'stack.template.json' },
});
const manifest = {
  version: '36.0.0',
  artifacts: {
    'demo-prod': stack('eu-west-1'),
    'demo-prod-CfMonitoring-0a1b2c3d': stack('us-east-1', ['demo-prod']),
  },
};
const events = [];
// The cdk commands deploy() ran, the directories it synthesized into, and the Regions whose bootstrap version it read.
const cdkSteps = [];
const assemblies = [];
const outputsFiles = [];
const bootstrapReads = [];
// The CDK output directory before the deploy: an earlier synth, and files that are not CDK's.
mkdirSync('cdk.out/keep', { recursive: true });
writeFileSync('cdk.out/manifest.json', JSON.stringify({ synth: 0 }));
writeFileSync('cdk.out/notes.txt', 'mine');
writeFileSync('cdk.out/keep/inner.txt', 'mine');
const published = () => JSON.parse(readFileSync('cdk.out/manifest.json', 'utf-8')).synth;
// The shared outputs document, as another production deploy of this checkout left it.
const theirs = { 'other-prod': { ApiUrl: 'https://other.execute-api.eu-west-1.amazonaws.com/' } };
const ours = { 'demo-prod-monitoring': { AlarmTopic: 'arn:topic' }, 'demo-prod': prod };
mkdirSync('.cdk-blocks-sandbox', { recursive: true });
writeFileSync(outputsFile, JSON.stringify(theirs));
const sharedOutputs = () => JSON.parse(readFileSync(outputsFile, 'utf-8'));
// The pid in the lock of the steps that write files every command of the checkout shares.
const synthLockHolder = () =>
  existsSync('.cdk-blocks-sandbox/synth.pid') ? JSON.parse(readFileSync('.cdk-blocks-sandbox/synth.pid', 'utf-8')).pid : undefined;
/** After a deploy: its own directory, its lock and its temp files are gone, and the output directory still has the files that were there. */
const assertTidy = () => {
  assert.deepEqual(readdirSync('.cdk-blocks-sandbox').filter((name) => name.startsWith('deploy-') || name.endsWith('.tmp')), []);
  assert.equal(synthLockHolder(), undefined);
  assert.equal(readFileSync('cdk.out/notes.txt', 'utf-8'), 'mine');
  assert.equal(readFileSync('cdk.out/keep/inner.txt', 'utf-8'), 'mine');
  // The deploy's own outputs document is not part of the assembly.
  assert.deepEqual(readdirSync('cdk.out').filter((name) => name.includes('outputs')), []);
};
// Imports are dynamic: mock.module applies only to modules imported after it.
const replace = async (url, overrides) => {
  const real = await import(url);
  mock.module(url, { namedExports: { ...real, ...overrides } });
};
await replace(moduleUrl('preflight-credentials'), {
  // VERIFIED: the credential check verified the account and found eu-west-1 bootstrapped,
  // so it returns that check; UNBOOTSTRAPPED names a Region without a bootstrap.
  assertAwsCredentials: async () =>
    process.env.VERIFIED
      ? {
          account: '111122223333',
          bootstrapCheck: {
            invocation: 'npm run deploy',
            account: '111122223333',
            region: 'eu-west-1',
            credentials: { accessKeyId: 'AKIAEXAMPLEFIXTURE', secretAccessKey: 'fixture-secret' },
            read: async ({ region }) => {
              bootstrapReads.push(region);
              if (region === process.env.UNBOOTSTRAPPED) throw Object.assign(new Error('raw sdk detail'), { name: 'ParameterNotFound' });
            },
          },
        }
      : undefined,
});
await replace(moduleUrl('ensure-secrets'), {
  loadProductionEnv: () => {},
});
let generated = 0;
await replace(moduleUrl('deploy-client-codegen'), {
  generateDeployClient: async () => {
    generated++;
    // The client is a file of the checkout: generated under the synth lock.
    assert.equal(synthLockHolder(), process.pid);
  },
});
await replace(new URL('../telemetry/trackCommand.js', scripts).href, { trackCommand: async (_name, fn) => fn() });
await replace(moduleUrl('deploy-stream'), {
  runStreaming: async (_cmd, args, options) => {
    cdkSteps.push(args[1]);
    assert.equal(options.env.NODE_OPTIONS, '--conditions=cdk');
    assert.equal(options.env.BLOCKS_STAGE, 'production');
    // Held while the app is synthesized (the frontend build, Hosting's staging), and not while
    // its assembly deploys: a second deploy of the checkout may start then.
    assert.equal(synthLockHolder(), args[1] === 'synth' ? process.pid : undefined);
    if (args[1] === 'synth') {
      // A directory of this deploy's own, inside the project: never the shared output directory,
      // which a second deploy could rewrite between the bootstrap check and the deploy.
      const assembly = args[args.indexOf('--output') + 1];
      assert.ok(assembly.startsWith(join(process.cwd(), '.cdk-blocks-sandbox', 'deploy-')), assembly);
      assert.ok(!assemblies.includes(assembly), 'every deploy synthesizes into a new directory');
      assert.deepEqual(readdirSync(assembly), []);
      assemblies.push(assembly);
      if (process.env.FAIL === 'synth') throw new Error('synth failed');
      writeFileSync(join(assembly, 'manifest.json'), JSON.stringify({ ...manifest, synth: assemblies.length }));
      return;
    }
    // The deploy takes the very directory the synth wrote and the check read: the app is not
    // synthesized (or built) again, and no other deploy's assembly can be in its place.
    const assembly = assemblies.at(-1);
    assert.equal(args[args.indexOf('--app') + 1], assembly);
    assert.equal(JSON.parse(readFileSync(join(assembly, 'manifest.json'), 'utf-8')).synth, assemblies.length);
    if (process.env.FAIL === 'deploy') throw new Error('deploy failed');
    // An outputs document of this deploy's own, in its own directory: never the shared one,
    // which another deploy of the checkout writes too.
    const file = args[args.indexOf('--outputs-file') + 1];
    assert.equal(dirname(file), assembly);
    assert.ok(!outputsFiles.includes(file), 'every deploy writes its own outputs document');
    outputsFiles.push(file);
    writeFileSync(file, JSON.stringify(ours));
    // Meanwhile that other deploy ends, and writes the shared document.
    writeFileSync(outputsFile, JSON.stringify(theirs));
  },
});
await replace(moduleUrl('wait-live'), {
  waitForLiveBuild: async () => {
    events.push('wait');
    // By now this deploy has replaced the shared document with its own outputs.
    assert.deepEqual(sharedOutputs(), ours);
    // A second production deploy rewrites the file with only its own stack.
    writeFileSync(outputsFile, JSON.stringify({ 'demo-jdoe': { ApiUrl: 'https://sandbox.example/' } }));
    return { live: true, attempts: 1, elapsedMs: 0, reason: 'live' };
  },
});
const { deploy } = await import(moduleUrl('deploy'));
`;
  const onDeployed = `${prelude}
// The running dev server's config, which the Node client and the e2e tests read.
const local = { apiUrl: 'http://localhost:3000/cdk-blocks/api', environment: 'local' };
// LEGACY: the config.json a sandbox deploy from core 0.8.0 or earlier wrote, with the sandbox's AWS URL.
const legacy = { apiUrl: 'https://stub.example/prod/cdk-blocks/api', environment: 'sandbox' };
mkdirSync('.cdk-blocks-sandbox', { recursive: true });
writeFileSync('.cdk-blocks-sandbox/config.json', JSON.stringify(process.env.LEGACY ? legacy : local));
await deploy({
  cdkAppPath: 'unused',
  projectRoot: process.cwd(),
  waitLive: true,
  waitLiveTimeoutSec: 5,
  onDeployed: (deployed) => events.push(deployed),
});
assert.deepEqual(events, [
  { stack: 'demo-prod', apiUrl: prod.ApiUrl, hostingUrl: prod.HostingHostingUrl1A2B3C4D },
  'wait',
]);
// One synth, then one deploy of its assembly; without a verified account, no bootstrap version is read.
assert.deepEqual(cdkSteps, ['synth', 'deploy']);
assert.deepEqual(bootstrapReads, []);
// The output directory holds this deploy's synth, as it did when cdk deploy synthesized into it.
assert.equal(published(), 1);
assert.equal(outputsFiles.length, 1);
assertTidy();
if (process.env.LEGACY) {
  assert.ok(!existsSync('.cdk-blocks-sandbox/config.json'), 'the legacy config.json is gone');
  assert.deepEqual(JSON.parse(readFileSync('.cdk-blocks-sandbox/config.sandbox.json', 'utf-8')), legacy);
} else {
  assert.deepEqual(JSON.parse(readFileSync('.cdk-blocks-sandbox/config.json', 'utf-8')), local);
}
assert.deepEqual(JSON.parse(readFileSync('.cdk-blocks-sandbox/config.production.json', 'utf-8')), {
  apiUrl: prod.ApiUrl,
  environment: 'production',
});
`;
  const bootstrap = `${prelude}
const options = { cdkAppPath: 'unused', projectRoot: process.cwd() };
if (process.env.UNBOOTSTRAPPED) {
  await assert.rejects(deploy(options), (error) => {
    // The message of the bootstrap check, for the Region of the monitoring stack.
    assert.match(error.message, /^CDK is not bootstrapped in Region us-east-1 of account 111122223333, so \`npm run deploy\` cannot deploy there/);
    assert.match(error.message, /^ {4}npx cdk bootstrap aws:\\/\\/111122223333\\/us-east-1 --app=$/m);
    return true;
  });
  // Nothing was deployed: the app stack would otherwise deploy before CDK fails on us-east-1.
  assert.deepEqual(cdkSteps, ['synth']);
  assert.deepEqual(outputsFiles, []);
  // Only the Region the credential check had not covered: eu-west-1 is not read a second time.
  assert.deepEqual(bootstrapReads, ['us-east-1']);
  // The synth that was checked is in the output directory all the same.
  assert.equal(published(), 1);
  // A deploy that failed leaves the shared outputs document as it was.
  assert.deepEqual(sharedOutputs(), theirs);
} else {
  // Two deploys: each synthesizes into its own directory (the fake synth refuses a repeated one).
  await deploy(options);
  await deploy(options);
  assert.deepEqual(cdkSteps, ['synth', 'deploy', 'synth', 'deploy']);
  assert.equal(assemblies.length, 2);
  assert.deepEqual(bootstrapReads, ['us-east-1', 'us-east-1']);
  assert.equal(published(), 2);
  // Each wrote its own outputs document, and the shared one holds the last deploy's.
  assert.equal(outputsFiles.length, 2);
  assert.deepEqual(sharedOutputs(), ours);
}
assertTidy();
`;
  const failure = `${prelude}
await assert.rejects(deploy({ cdkAppPath: 'unused', projectRoot: process.cwd() }), new RegExp(process.env.FAIL + ' failed'));
// A failed deploy still leaves its synth in the output directory; a synth that wrote no
// manifest leaves the earlier one there.
assert.equal(published(), process.env.FAIL === 'deploy' ? 1 : 0);
assert.deepEqual(cdkSteps, process.env.FAIL === 'deploy' ? ['synth', 'deploy'] : ['synth']);
// The shared outputs document is the other deploy's still: only a deploy that succeeded replaces it.
assert.deepEqual(sharedOutputs(), theirs);
assertTidy();
`;

  function run(fixture: string, env: NodeJS.ProcessEnv = {}): void {
    const dir = mkdtempSync(join(tmpdir(), 'blocks-on-deployed-'));
    try {
      execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', fixture], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, CDK_DISABLE_CLI_TELEMETRY: '1', ...env },
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 15_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const legacy of [false, true]) {
  it(legacy
    ? 'moves a config.json an older sandbox deploy wrote into config.sandbox.json, and removes it'
    : 'reports the stack outputs it read before the liveness wait, which a second production deploy can overwrite', () => {
    // It also records its API URL in config.production.json, and leaves the dev server's config.json alone.
    run(onDeployed, legacy ? { LEGACY: '1' } : {});
  });
  }

  it('stops before cdk deploy when a stack is in a Region where CDK is not bootstrapped', () => {
    run(bootstrap, { VERIFIED: '1', UNBOOTSTRAPPED: 'us-east-1' });
  });

  it('synthesizes each deploy into its own directory and deploys that directory, once every Region is bootstrapped', () => {
    run(bootstrap, { VERIFIED: '1' });
  });

  for (const step of ['synth', 'deploy']) {
    it(`removes its assembly directory and keeps the output directory's other files after a failed ${step}`, () => {
      run(failure, { FAIL: step });
    });
  }

  it('stops before it generates or builds anything while another command of the checkout synthesizes', () => {
    run(`${prelude}
// The lock of another command that still runs (this fixture's parent process plays it).
const theirLock = JSON.stringify({ pid: process.ppid, ppid: 1, port: 0, token: 'theirs', invocation: 'npm run deploy -- --profile other' });
writeFileSync('.cdk-blocks-sandbox/synth.pid', theirLock);
await assert.rejects(deploy({ cdkAppPath: 'unused', projectRoot: process.cwd() }), (error) => {
  assert.match(error.message, new RegExp('^\`npm run deploy -- --profile other\` \\\\(pid ' + process.ppid + '\\\\) is generating the client and synthesizing this app'));
  assert.match(error.message, /Wait for it to finish its synth, then re-run \`npm run deploy\`\\.$/);
  return true;
});
assert.equal(generated, 0);
assert.deepEqual(cdkSteps, []);
assert.deepEqual(readdirSync('.cdk-blocks-sandbox').filter((name) => name.startsWith('deploy-')), []);
// Their lock is theirs still.
assert.equal(readFileSync('.cdk-blocks-sandbox/synth.pid', 'utf-8'), theirLock);
assert.equal(published(), 0);
assert.deepEqual(sharedOutputs(), theirs);
`);
  });
});

describe('publishAssembly — the synthesized assembly in the CDK output directory', () => {
  /** A project with a synthesized assembly in `.cdk-blocks-sandbox/deploy-x`; `files` maps a path in it to its content. */
  function project(t: { after: (fn: () => void) => void }, files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'blocks-publish-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const synthesized = join(root, '.cdk-blocks-sandbox', 'deploy-x');
    write(synthesized, files);
    const warn = mock.method(console, 'warn', () => {});
    t.after(() => warn.mock.restore());
    return { root, synthesized, warnings: () => warn.mock.calls.map((call) => String(call.arguments[0])) };
  }
  function write(dir: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  const read = (path: string) => readFileSync(path, 'utf-8');
  const ASSEMBLY = {
    'manifest.json': 'new manifest',
    'app.template.json': 'new template',
    'app.blocks-iam.json': 'new report',
    'asset.abc/index.js': 'new asset',
    'assembly-Stage/manifest.json': 'new stage',
  };

  it('overwrites the files of the same name and removes nothing from the output directory', (t) => {
    const { root, synthesized, warnings } = project(t, ASSEMBLY);
    const output = join(root, 'cdk.out');
    write(output, {
      'manifest.json': 'old manifest',
      'old.template.json': 'template of a stack the app no longer has',
      'asset.abc/other.js': 'file of an earlier synth',
      'asset.def/index.js': 'asset of an earlier synth',
      'notes.txt': 'mine',
      'reports/2026.txt': 'mine',
    });
    publishAssembly(synthesized, output);
    assert.deepStrictEqual(warnings(), []);
    assert.strictEqual(read(join(output, 'manifest.json')), 'new manifest');
    assert.strictEqual(read(join(output, 'app.template.json')), 'new template');
    assert.strictEqual(read(join(output, 'app.blocks-iam.json')), 'new report');
    assert.strictEqual(read(join(output, 'asset.abc', 'index.js')), 'new asset');
    assert.strictEqual(read(join(output, 'asset.abc', 'other.js')), 'file of an earlier synth');
    assert.strictEqual(read(join(output, 'assembly-Stage', 'manifest.json')), 'new stage');
    // Like a synth into the directory: what the assembly does not name stays.
    assert.strictEqual(read(join(output, 'old.template.json')), 'template of a stack the app no longer has');
    assert.strictEqual(read(join(output, 'asset.def', 'index.js')), 'asset of an earlier synth');
    assert.strictEqual(read(join(output, 'notes.txt')), 'mine');
    assert.strictEqual(read(join(output, 'reports', '2026.txt')), 'mine');
    // The assembly is only read: the deploy that made the directory removes it.
    assert.strictEqual(read(join(synthesized, 'manifest.json')), 'new manifest');
  });

  it('creates an output directory that does not exist', (t) => {
    const { root, synthesized } = project(t, ASSEMBLY);
    publishAssembly(synthesized, join(root, 'build', 'cdk.out'));
    assert.strictEqual(read(join(root, 'build', 'cdk.out', 'manifest.json')), 'new manifest');
  });

  it('leaves the project intact when cdk.json sets "output": "."', (t) => {
    const { root, synthesized } = project(t, ASSEMBLY);
    write(root, {
      'package.json': '{}',
      'cdk.json': '{"output":"."}',
      'src/app.ts': 'code',
      'node_modules/dep/index.js': 'dep',
      '.cdk-blocks-sandbox/sandbox-id.txt': 'jdoe-abc123',
    });
    publishAssembly(synthesized, root);
    assert.strictEqual(read(join(root, 'manifest.json')), 'new manifest');
    assert.strictEqual(read(join(root, 'asset.abc', 'index.js')), 'new asset');
    assert.strictEqual(read(join(root, 'package.json')), '{}');
    assert.strictEqual(read(join(root, 'cdk.json')), '{"output":"."}');
    assert.strictEqual(read(join(root, 'src', 'app.ts')), 'code');
    assert.strictEqual(read(join(root, 'node_modules', 'dep', 'index.js')), 'dep');
    assert.strictEqual(read(join(root, '.cdk-blocks-sandbox', 'sandbox-id.txt')), 'jdoe-abc123');
    assert.strictEqual(read(join(synthesized, 'manifest.json')), 'new manifest');
  });

  it('copies no CDK lock file, leaves a reader lock of a process that is gone, and takes over such a writer lock', (t) => {
    const { root, synthesized } = project(t, { ...ASSEMBLY, 'synth.lock': '4242', 'read.4242.1.lock': '4242' });
    const output = join(root, 'cdk.out');
    write(output, { 'read.999999999.1.lock': '999999999', 'synth.lock': '999999999' });
    publishAssembly(synthesized, output);
    assert.strictEqual(read(join(output, 'manifest.json')), 'new manifest');
    assert.ok(!existsSync(join(output, 'read.4242.1.lock')));
    assert.strictEqual(read(join(output, 'read.999999999.1.lock')), '999999999');
    // The copy held the writer lock in place of the stale one, and released it.
    assert.deepStrictEqual(readdirSync(output).filter((name) => name.startsWith('synth.lock')), []);
  });

  it('copies nothing while another process holds the writer lock of the output directory, and says so', (t) => {
    const { root, synthesized, warnings } = project(t, ASSEMBLY);
    const output = join(root, 'cdk.out');
    for (const pid of [String(process.pid), 'not a pid']) {
      write(output, { 'manifest.json': 'their manifest', 'synth.lock': pid });
      publishAssembly(synthesized, output);
      assert.deepStrictEqual(readdirSync(output).sort(), ['manifest.json', 'synth.lock']);
      assert.strictEqual(read(join(output, 'manifest.json')), 'their manifest');
      // Their lock is theirs still.
      assert.strictEqual(read(join(output, 'synth.lock')), pid);
    }
    assert.strictEqual(warnings().length, 2);
    assert.match(warnings()[0], /Not copying the synthesized cloud assembly .*another process \(pid \d+\) is writing a cloud assembly there/);
  });

  it('holds the writer lock while it copies, so a second deploy that ends meanwhile does not mix its files in', (t) => {
    const first = project(t, ASSEMBLY);
    const second = project(t, { 'manifest.json': 'second manifest', 'app.template.json': 'second template' });
    const output = join(first.root, 'cdk.out');
    let lockDuringCopy: string | undefined;
    publishAssembly(first.synthesized, output, () => {
      lockDuringCopy = read(join(output, 'synth.lock'));
      // The second deploy ends while the first one copies.
      publishAssembly(second.synthesized, output);
    });
    assert.strictEqual(lockDuringCopy, String(process.pid));
    assert.strictEqual(read(join(output, 'manifest.json')), 'new manifest');
    assert.strictEqual(read(join(output, 'app.template.json')), 'new template');
    assert.strictEqual(second.warnings().length, 1);
    // Released afterwards, and the second deploy's refusal did not remove the first one's lock.
    assert.ok(!existsSync(join(output, 'synth.lock')));
    publishAssembly(second.synthesized, output);
    assert.strictEqual(read(join(output, 'manifest.json')), 'second manifest');
  });

  it('copies nothing while another CDK process reads the assembly of the output directory, and says so', (t) => {
    const { root, synthesized, warnings } = project(t, ASSEMBLY);
    const output = join(root, 'cdk.out');
    // A `cdk deploy --app cdk.out` that still runs: it reads templates and assets as it deploys.
    const lock = `read.${process.pid}.1.lock`;
    write(output, { 'manifest.json': 'their manifest', [lock]: String(process.pid) });
    publishAssembly(synthesized, output);
    assert.deepStrictEqual(readdirSync(output).sort(), ['manifest.json', lock]);
    assert.strictEqual(read(join(output, 'manifest.json')), 'their manifest');
    assert.strictEqual(warnings().length, 1);
    assert.match(warnings()[0], /Not copying the synthesized cloud assembly .*another CDK process \(pid \d+\) is reading the assembly there/);
  });

  it('copies only the IAM report of a synth that wrote no manifest', (t) => {
    const { root, synthesized } = project(t, { 'app.blocks-iam.json': 'violations', 'app.template.json': 'half a synth' });
    const output = join(root, 'cdk.out');
    write(output, { 'manifest.json': 'old manifest', 'app.template.json': 'old template', 'app.blocks-iam.json': 'old report' });
    publishAssembly(synthesized, output);
    // The report a failed app-isolation check names; the earlier synth is otherwise as it was.
    assert.strictEqual(read(join(output, 'app.blocks-iam.json')), 'violations');
    assert.strictEqual(read(join(output, 'manifest.json')), 'old manifest');
    assert.strictEqual(read(join(output, 'app.template.json')), 'old template');
  });

  it('does nothing for a synth that wrote nothing, and creates no output directory', (t) => {
    const { root, synthesized } = project(t, {});
    mkdirSync(synthesized, { recursive: true });
    publishAssembly(synthesized, join(root, 'cdk.out'));
    assert.ok(!existsSync(join(root, 'cdk.out')));
  });

  it('warns, and does not throw, when the assembly cannot be copied', (t) => {
    const { root, synthesized, warnings } = project(t, ASSEMBLY);
    // The output "directory" is a file: nothing can be created in it.
    write(root, { 'cdk.out': 'a file' });
    publishAssembly(synthesized, join(root, 'cdk.out'));
    assert.strictEqual(read(join(root, 'cdk.out')), 'a file');
    assert.strictEqual(warnings().length, 1);
    assert.match(warnings()[0], /Could not copy the synthesized cloud assembly/);
  });
});
