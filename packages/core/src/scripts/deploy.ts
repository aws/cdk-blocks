// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { loadProductionEnv } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { assemblyBootstrapFailure } from './preflight-bootstrap.js';
import { resolveDeploymentTarget } from './deployment-target.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv, getFrameworkSinkEnv } from './cdk-telemetry-env.js';
import { runStreaming, buildCdkDeployArgs, buildCdkSynthArgs, formatDeploySignal } from './deploy-stream.js';
import { topLevelStackNodes } from './sandbox.js';
import { generateDeployClient } from './deploy-client-codegen.js';
import { createDeployRecorder } from './deploy-history.js';
import { type InvalidationProbe, waitForLiveBuild, type WaitForLiveResult } from './wait-live.js';
import { createFrameworkSink, registerFrameworkFromSink } from '../telemetry/framework-sink.js';
import { createCdkOutput } from './cdk-output.js';
import { BACKEND_OUTPUT_KEY, OUTPUTS_FILE } from './deploy-outputs.js';
import { ignoreClosedOutput, log } from './log.js';
import { migrateLegacyDeployedConfig, writeDeployedConfig } from './deployed-config.js';
import { migrateLegacySandboxDir } from './migrate-sandbox-dir.js';
import { isPidAlive } from './dev-pidfile.js';
import { acquireSynthLock } from './synth-lock.js';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';

export interface DeployOptions {
  cdkAppPath: string;
  projectRoot: string;
  /**
   * When true, block until the new frontend build is actually served through
   * CloudFront before emitting `BLOCKS_DEPLOYED`, so a caller's immediate
   * self-test can't hit a stale bundle during edge propagation. No-op for a
   * backend-only app.
   */
  waitLive?: boolean;
  /** Overall budget for the liveness wait, in seconds. Defaults to 180. */
  waitLiveTimeoutSec?: number;
  /**
   * Called with the outputs of the deployed stack as soon as the deploy has read
   * them, before the liveness wait. The deploy reads them from an outputs
   * document of its own, never from `.cdk-blocks-sandbox/outputs.production.json`,
   * which another production deploy of the same checkout replaces when it ends.
   * A launcher that reports the result records them here, rather than reading that
   * file afterwards, for the same reason.
   */
  onDeployed?: (deployed: DeployedStack) => void;
  /** How the user runs the deploy, in the guidance. Default: `npm run deploy`. */
  invocation?: string;
}

/** The stack a production deploy deployed, from the outputs it read. */
export interface DeployedStack {
  /** The stack whose outputs carry `ApiUrl`. */
  stack: string;
  apiUrl: string;
  /** The frontend URL, when the stack hosts a frontend. */
  hostingUrl?: string;
}

/** Default liveness-wait budget (seconds). */
export const DEFAULT_WAIT_LIVE_TIMEOUT_SEC = 180;
/** Poll interval for the liveness wait, in milliseconds. */
export const WAIT_LIVE_INTERVAL_MS = 2_000;

/**
 * Parse the `--wait-live` flags from an argv tail. Pure and exported so flag
 * handling is unit-tested without spawning a deploy. An out-of-range or
 * non-numeric timeout falls back to the default rather than failing the deploy.
 */
export function parseWaitLiveArgs(argv: readonly string[]): {
  waitLive: boolean;
  waitLiveTimeoutSec: number;
} {
  const waitLive = argv.includes('--wait-live');
  let waitLiveTimeoutSec = DEFAULT_WAIT_LIVE_TIMEOUT_SEC;
  const timeoutArg = argv.find((a) => a.startsWith('--wait-live-timeout='));
  if (timeoutArg) {
    const raw = Number(timeoutArg.slice('--wait-live-timeout='.length));
    // Floor BEFORE the range check so a fractional value like 0.5 is rejected
    // (it would otherwise floor to a 0s budget) rather than silently accepted.
    const seconds = Math.floor(raw);
    if (Number.isFinite(raw) && seconds >= 1 && seconds <= 3600) {
      waitLiveTimeoutSec = seconds;
    } else {
      console.warn(
        `⚠️  Ignoring --wait-live-timeout=${timeoutArg.slice('--wait-live-timeout='.length)} ` +
          `(expected a whole number of seconds, 1–3600); using ${DEFAULT_WAIT_LIVE_TIMEOUT_SEC}s.`,
      );
    }
  }
  return { waitLive, waitLiveTimeoutSec };
}

// Re-exported from deploy-stream (the shared module) so existing importers of
// `./deploy.js` — including deploy.test.ts — keep resolving it here while
// sandbox() imports the same helper without pulling in deploy()'s dependency
// chain.
export { formatDeploySignal };

/** The HostingUrl/BuildId/InvalidationId outputs resolved for one frontend. */
export interface ResolvedHostingOutputs {
  /** Public frontend origin; falls back to the early-stream URL when no output matched. */
  hostingUrl?: string;
  /** The `HostingBuildId` output value for the same Hosting group, if present. */
  expectedBuildId?: string;
  /** The `HostingInvalidationId` output value (`<distributionId>/<invalidationId>`), if present. */
  invalidationId?: string;
}

/**
 * Pair the HostingUrl, BuildId and InvalidationId outputs for a SINGLE Hosting
 * construct, so the liveness poll waits on one frontend's own ids rather than
 * independent first-matches that could cross groups on a two-Hosting stack.
 *
 * A Hosting construct's CfnOutput logical ids share a prefix and a CDK
 * 8-hex-hash suffix, e.g. `HostingHostingUrl1A2B3C4D`,
 * `HostingHostingBuildId8EDD8441`, `HostingHostingInvalidationIdF60AF4B3`. We
 * anchor on the first `…HostingUrl<hash>` output, take its prefix, and match
 * the sibling ids by the EXACT `<prefix>HostingBuildId<hash>` shape — not a
 * `startsWith`, which would let a `Web`/`WebAdmin` pair collide. Pure and
 * exported so the pairing is unit-tested against real logical ids.
 *
 * `--wait-live` targets a single-frontend stack; the first Hosting group is
 * that frontend. `earlyHostingUrl` is the URL captured from the deploy stream,
 * used when no `HostingUrl` output is present.
 */
export function resolveHostingOutputs(
  stackOutputs: Record<string, string>,
  earlyHostingUrl?: string,
): ResolvedHostingOutputs {
  const keys = Object.keys(stackOutputs);
  // Anchor on the first output whose id contains `HostingUrl`. CDK suffixes a
  // nested construct's CfnOutput id with a hash, so the real key looks like
  // `HostingHostingUrl1A2B3C4D`.
  const urlKey = keys.find((k) => k.includes('HostingUrl'));
  const hostingUrl = urlKey ? stackOutputs[urlKey] : earlyHostingUrl;

  // Derive the group prefix from the matched Url key (everything up to and
  // including `Hosting`, i.e. the part before `Url`). Sibling ids must share
  // this exact prefix AND end in only the CDK hash (hex) — anchoring on the
  // hex tail rather than a loose `startsWith` is what stops a `Web`/`WebAdmin`
  // pair from colliding (their prefixes differ, so neither matches the other).
  const prefix = urlKey ? urlKey.slice(0, urlKey.indexOf('HostingUrl') + 'Hosting'.length) : undefined;
  const siblingFor = (suffix: string): string | undefined => {
    const k = keys.find((key) =>
      prefix === undefined
        ? key.includes(`Hosting${suffix}`)
        : key.startsWith(`${prefix}${suffix}`) && /^[0-9A-Fa-f]*$/.test(key.slice(`${prefix}${suffix}`.length)),
    );
    return k ? stackOutputs[k] : undefined;
  };

  return {
    hostingUrl,
    expectedBuildId: siblingFor('BuildId'),
    invalidationId: siblingFor('InvalidationId'),
  };
}

/** The two halves of a `HostingInvalidationId` output, present only when both
 * are non-empty. */
export interface ParsedInvalidationId {
  distributionId: string;
  invId: string;
}

/**
 * Split a `HostingInvalidationId` output (`<distributionId>/<invalidationId>`)
 * into its two halves, returning `undefined` for a malformed/empty pair so the
 * caller degrades to the config-only wait rather than probing with an undefined
 * id. The producer always emits both halves (a CloudFront invalidation id never
 * contains a slash — see hosting.ts), so this guards a shape that can't occur
 * today but would otherwise surface as an opaque `GetInvalidation` error.
 * Pure and exported so the guard is unit-tested.
 */
export function parseInvalidationId(invalidationId: string | undefined): ParsedInvalidationId | undefined {
  if (!invalidationId) return undefined;
  const [distributionId, invId] = invalidationId.split('/');
  if (!distributionId || !invId) return undefined;
  return { distributionId, invId };
}

/** The slice of a CloudFront client the invalidation probe needs — lets a test
 * inject a fake without the real SDK. */
export interface InvalidationStatusClient {
  send(command: unknown, options: { abortSignal: AbortSignal }): Promise<{ Invalidation?: { Status?: string } }>;
}

/**
 * Classify an invalidation-probe error as terminal (can never clear during this
 * deploy) vs. transient (retry). Terminal cases: the credentials can't read the
 * invalidation (`AccessDenied`), the id/distribution doesn't exist
 * (`NoSuchInvalidation`/`NoSuchDistribution`), or the client has no Region
 * (`Region is missing`). Everything else (throttling, 5xx, a timeout) is
 * transient. Pure and exported so the classification is unit-tested.
 */
export function classifyInvalidationError(error: unknown): { fatal: string } | 'transient' {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const terminalNames = new Set([
    'AccessDenied',
    'AccessDeniedException',
    'NoSuchInvalidation',
    'NoSuchDistribution',
  ]);
  if (terminalNames.has(name)) return { fatal: name };
  if (/region is missing/i.test(message)) return { fatal: 'Region is missing' };
  return 'transient';
}

/**
 * Build the injected invalidation-status probe `waitForLiveBuild` calls. Reads
 * `GetInvalidation` through the given client and maps the result to the pure
 * `InvalidationProbeResult`: `'completed'`/`'pending'`, or a terminal `{ fatal }`
 * for an error that can never clear (see {@link classifyInvalidationError}).
 * Exported with the client injected so the mapping is tested without the SDK.
 */
export function makeInvalidationProbe(
  client: InvalidationStatusClient,
  getInvalidationCommand: (distributionId: string, invalidationId: string) => unknown,
  distributionId: string,
  invalidationId: string,
): InvalidationProbe {
  return async (reqTimeoutMs) => {
    try {
      const res = await client.send(getInvalidationCommand(distributionId, invalidationId), {
        abortSignal: AbortSignal.timeout(reqTimeoutMs),
      });
      return res.Invalidation?.Status === 'Completed' ? 'completed' : 'pending';
    } catch (error) {
      const classified = classifyInvalidationError(error);
      return classified === 'transient' ? 'pending' : classified;
    }
  };
}

/**
 * The prefix of the directory, inside the project's {@link BLOCKS_SANDBOX_DIR},
 * where one `npm run deploy` synthesizes the app. Each deploy makes its own
 * directory (`mkdtemp`), checks the stacks in it and deploys from it: a second
 * deploy of the same checkout (another profile, another terminal) can't
 * replace the assembly between the check and the deploy, as it could in a
 * shared directory, where the CDK CLI holds its lock only while it runs. It is
 * inside the project so that the app resolves its modules and assets as in
 * any other synth. {@link publishAssembly} copies it to the CDK output directory.
 */
export const PRODUCTION_DEPLOY_ASSEMBLY_PREFIX = 'deploy-';

/**
 * The outputs document of one deploy (`cdk deploy --outputs-file`), inside that
 * deploy's own directory. Everything the deploy reports and checks (the API and
 * frontend URLs, the build id for `--wait-live`) is read from it, so two
 * deploys of one checkout that overlap never report each other's stack. A
 * deploy that succeeds then replaces the shared `OUTPUTS_FILE.production`,
 * which the other commands read, with it. Not part of the cloud assembly: it
 * is not copied to the CDK output directory.
 */
const RUN_OUTPUTS_FILE = 'deploy-outputs.json';

/** The file name suffix of the IAM report a synth writes into the assembly (see `cdk/iam-report.ts`). */
const IAM_REPORT_SUFFIX = '.blocks-iam.json';

/** The lock file of a CDK CLI that is synthesizing into a directory (`RWLock` in aws-cdk); it holds that CLI's pid. */
const CDK_WRITER_LOCK = 'synth.lock';

/** The lock file of a CDK CLI that reads the assembly of a directory (`cdk deploy --app <dir>`): `read.<pid>.<n>.lock`. */
const CDK_READER_LOCK = /^read\.(\d+)\.\d+\.lock$/;

/** The CDK CLI's lock files in a cloud assembly directory: the writer's, and one per reader. */
const CDK_LOCK_FILE = /^(?:synth\.lock|read\..*\.lock)$/;

/**
 * Take the CDK CLI's writer lock of `outputDir` for this process, as a synth
 * into it would: `synth.lock`, created exclusively, holding the pid. Returns
 * the release, which removes the lock only while it is still this process's,
 * or the holder when a live process (or a lock that names no pid) has it. A
 * lock of a process that is gone is moved aside and removed only if it is
 * still the one that was read, so a lock taken meanwhile is never deleted.
 */
function claimCdkWriterLock(outputDir: string): { release: () => void } | { holder: string } {
  const path = join(outputDir, CDK_WRITER_LOCK);
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, mine, { flag: 'wx' });
      return {
        release: () => {
          try {
            if (readFileSync(path, 'utf-8').trim() === mine) unlinkSync(path);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: string;
    try {
      holder = readFileSync(path, 'utf-8').trim();
    } catch {
      continue; // released between the create and the read
    }
    if (!/^\d+$/.test(holder) || isPidAlive(Number(holder))) return { holder };
    const aside = `${path}.${mine}.stale`;
    try {
      renameSync(path, aside);
      // Another process replaced the stale lock before the rename: give it back.
      if (readFileSync(aside, 'utf-8').trim() !== holder) linkSync(aside, path);
    } catch {
      // Gone, or taken again: the next attempt reads it.
    }
    rmSync(aside, { force: true });
  }
  return { holder: '' };
}

/**
 * Copy the assembly a deploy synthesized into `synthesizedDir` to `outputDir`,
 * the directory the CDK CLI writes to (`output` in cdk.json, else `cdk.out`),
 * so that it holds the last synth as it did when `cdk deploy` synthesized on
 * its own: the templates and the IAM report (`cdk.out/<stack>.blocks-iam.json`).
 * Called once the deploy is over, whatever its outcome.
 *
 * `outputDir` is the user's: it can be the project directory (`"output": "."`)
 * or a directory shared with other files. So it is written as a synth into it
 * would write it, and never removed or replaced: each entry of the assembly
 * replaces the entry of the same name, and everything else stays. The CLI's
 * lock files are not copied.
 *
 * The copy holds the CLI's writer lock of `outputDir` (see
 * {@link claimCdkWriterLock}), so two deploys that end together never mix
 * their files there, and a CDK CLI does not read half a copy. While another
 * process holds that lock (a synth into `outputDir`, another deploy's copy),
 * or a CDK process reads the assembly there (`cdk deploy --app cdk.out` reads
 * templates and assets as it goes), nothing is copied.
 *
 * A synth that failed before it wrote `manifest.json` copies only the IAM
 * reports it did write: a synth that fails on an app-isolation violation names
 * its report, which holds the violations, inside the per-deploy directory.
 *
 * Never throws: a failure here is a warning, and must not replace the result
 * of the deploy. `synthesizedDir` is only read; its owner removes it.
 *
 * @param whileLocked test seam: called once the writer lock is held, before the copy
 * @internal
 */
export function publishAssembly(synthesizedDir: string, outputDir: string, whileLocked?: () => void): void {
  // The synth printed paths inside `synthesizedDir` (the IAM report); say where the files are now.
  const shown = relative(process.cwd(), outputDir) || '.';
  try {
    const synthesized = existsSync(join(synthesizedDir, 'manifest.json'));
    const entries = readdirSync(synthesizedDir).filter(
      (name) => !CDK_LOCK_FILE.test(name) && name !== RUN_OUTPUTS_FILE && (synthesized || name.endsWith(IAM_REPORT_SUFFIX)),
    );
    if (entries.length === 0) return;
    mkdirSync(outputDir, { recursive: true });
    const lock = claimCdkWriterLock(outputDir);
    if ('holder' in lock) {
      log.warn(
        `⚠️  Not copying the synthesized cloud assembly to ${shown}: another process (pid ${lock.holder || 'unknown'}) is ` +
          `writing a cloud assembly there (${CDK_WRITER_LOCK}). The deploy's result is not affected; ${shown} holds that process's synth.`,
      );
      return;
    }
    try {
      // Read after the lock is held: a reader that came before it is seen, and none starts under it.
      const reader = readdirSync(outputDir)
        .map((name) => CDK_READER_LOCK.exec(name)?.[1])
        .find((pid) => pid !== undefined && isPidAlive(Number(pid)));
      if (reader !== undefined) {
        log.warn(
          `⚠️  Not copying the synthesized cloud assembly to ${shown}: another CDK process (pid ${reader}) is reading the ` +
            `assembly there. The deploy's result is not affected; ${shown} holds the earlier synth.`,
        );
        return;
      }
      whileLocked?.();
      // Copied over what is there, as a synth into `outputDir` writes: nothing else in it is removed.
      for (const entry of entries) {
        cpSync(join(synthesizedDir, entry), join(outputDir, entry), { recursive: true });
        if (!synthesized) log.progress(`   IAM report of the failed synth: ${join(shown, entry)}`);
      }
      if (synthesized) log.detail(`   Cloud assembly of this deploy (templates, IAM report): ${shown}`);
    } finally {
      lock.release();
    }
  } catch (error) {
    log.warn(
      `⚠️  Could not copy the synthesized cloud assembly to ${outputDir}, which may hold an earlier synth or part ` +
        `of this one: ${error instanceof Error ? error.message : String(error)}`,
    );
    log.debugError(error);
  }
}

export async function deploy(options: DeployOptions) {
  // A closed terminal (SIGHUP, then EIO) or output pipe must not end the deploy (see ignoreClosedOutput).
  ignoreClosedOutput();
  // Structured deploy history (.cdk-blocks/deploy-history.jsonl) is the primary
  // source for the dashboard's deployments view: IN_PROGRESS at start, one
  // terminal record (same id) at the end. Best-effort, never fails a deploy.
  const recorder = createDeployRecorder(options.projectRoot, 'production');
  recorder.start();
  try {
    const result = await runDeploy(options);
    recorder.succeed();
    return result;
  } catch (error) {
    recorder.fail(error);
    throw error;
  }
}

async function runDeploy(options: DeployOptions) {
  return trackCommand('deploy', async () => {
    log.progress('🏗️  Preparing deployment...');
    migrateLegacySandboxDir(options.projectRoot);
    migrateLegacyDeployedConfig(join(options.projectRoot, BLOCKS_SANDBOX_DIR));

    // Resolve the liveness-wait config: an explicit option wins, else read the
    // flags from argv so the thin template wrapper needs no arg plumbing. Only
    // parse argv when an explicit option is absent — otherwise a stray/invalid
    // `--wait-live-timeout=` on argv would emit a warning on a path that then
    // ignores the parsed value.
    const needsArgv = options.waitLive === undefined || options.waitLiveTimeoutSec === undefined;
    const argvWaitLive = needsArgv ? parseWaitLiveArgs(process.argv.slice(2)) : undefined;
    const waitLive = options.waitLive ?? argvWaitLive?.waitLive ?? false;
    const waitLiveTimeoutSec =
      options.waitLiveTimeoutSec ?? argvWaitLive?.waitLiveTimeoutSec ?? DEFAULT_WAIT_LIVE_TIMEOUT_SEC;

    // Load production environment (from .env.production or CI env vars)
    loadProductionEnv();

    process.env.BLOCKS_STAGE = 'production';

    // Fail fast if AWS credentials are missing/expired, or the account and Region were
    // never CDK-bootstrapped, before generating the client and spending time in synth
    // only to hit an opaque CDK error.
    const verified = await assertAwsCredentials({
      command: 'deploy',
      invocation: options.invocation,
      projectRoot: options.projectRoot,
      checkBootstrap: true,
    });

    // Where the CDK CLI writes the cloud assembly: `output` in cdk.json, or the CLI's default.
    // The deploy synthesizes into a directory of its own (see PRODUCTION_DEPLOY_ASSEMBLY_PREFIX),
    // and copies the assembly there once it is over.
    const outputDir = resolve(
      options.projectRoot,
      (await resolveDeploymentTarget({ projectRoot: options.projectRoot })).assemblyDir ?? 'cdk.out',
    );
    const sandboxDir = resolve(options.projectRoot, BLOCKS_SANDBOX_DIR);
    mkdirSync(sandboxDir, { recursive: true });

    // The client, the frontend build and Hosting's staging directory are files every
    // command of this checkout shares: held from here until the synth has exited, the
    // lock keeps another deploy from writing them meanwhile (see synth-lock.ts). It
    // stops this deploy, before anything is generated, when another command holds it.
    const synthLock = acquireSynthLock(options.projectRoot, options.invocation ?? 'npm run deploy');
    let assemblyDir: string;
    try {
      // Generate client code FIRST (before cdk deploy triggers the Vite build).
      // This also populates the BB registry for telemetry — from a child process,
      // never by importing the backend here: an in-process import loads the local
      // mock layer, whose runtimes (PGlite, CronJob schedulers, …) kept this
      // process alive forever after the deploy finished.
      const foundationPath = resolve(options.projectRoot, 'cdk-blocks/index.ts');
      const clientPath = join(dirname(foundationPath), 'client.js');
      log.progress('📝 Generating client code...');
      await generateDeployClient(foundationPath, clientPath);

      log.progress('🚀 Deploying to AWS...');
      log.detail('   (This may take a few minutes on first deploy)');
      // Not "Frontend hosting": the app may have none, and that is known only from its outputs.
      log.detail('   - Backend API (Lambda + API Gateway), and frontend hosting when the app defines it');
      log.detail('   Streaming CloudFormation events below; the deploy keeps running if this');
      log.detail('   process is backgrounded (press Ctrl-C, or send SIGTERM twice, to abort).');

      // This deploy's own directory, for its assembly and its outputs document; removed below.
      assemblyDir = mkdtempSync(join(sandboxDir, PRODUCTION_DEPLOY_ASSEMBLY_PREFIX));
    } catch (error) {
      synthLock.release();
      throw error;
    }
    const runOutputsFile = join(assemblyDir, RUN_OUTPUTS_FILE);

    // At BLOCKS_LOG_LEVEL=quiet|normal the CDK stream is condensed and the raw
    // lines are retained, so a failure below can still print them.
    const cdkOutput = createCdkOutput({ label: 'cdk deploy', verb: 'deploy' });

    // Captured from the CDK progress stream the moment CloudFront's URL appears
    // — well before CREATE_COMPLETE and the post-run outputs read. Printing
    // it early means a deploy that is still converging, or gets killed at a
    // caller's timeout, has already surfaced where the frontend lives.
    let earlyHostingUrl: string | undefined;

    // Framework resolves in the cdk synth child (where Hosting is built); it writes the
    // value to this file so the parent can attach it to telemetry. Created immediately
    // before the spawn, so a failure earlier in the command leaves nothing behind.
    const frameworkSink = createFrameworkSink(options.projectRoot);

    const cdkRun = {
      label: 'cdk deploy',
      cwd: options.projectRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: '--conditions=cdk',
        ...getCdkTelemetryEnv('production', options.projectRoot),
        ...getFrameworkSinkEnv(frameworkSink, options.projectRoot),
      },
      curated: cdkOutput.streams,
    };

    // The outputs document `cdk deploy` wrote for this deploy, read before its directory is removed.
    let runOutputs: string;
    // Which step failed: only a CDK step has retained output to print.
    let phase: 'synth' | 'bootstrap' | 'deploy' = 'synth';
    try {
      // Synthesize once, then deploy that assembly, as the sandbox does: the
      // stacks and their Regions are known before anything deploys, and the
      // frontend build still runs only once. The same directory goes to the
      // synth, to the check and to the deploy.
      try {
        await runStreaming('npx', buildCdkSynthArgs({ projectRoot: options.projectRoot, assemblyDir }), cdkRun);
      } finally {
        // The assembly now has its own copy of every asset: what follows needs no shared file,
        // and another deploy of this checkout may start.
        synthLock.release();
      }

      // The check above covered the configured Region. A stack can be in another
      // one (Hosting's us-east-1 CloudFront monitoring stack), and CDK deploys it
      // after the app stack, so a missing bootstrap there would otherwise fail a
      // deploy that has already created the app.
      phase = 'bootstrap';
      const unbootstrapped =
        verified?.bootstrapCheck &&
        (await assemblyBootstrapFailure(verified.bootstrapCheck, topLevelStackNodes(assemblyDir)));
      if (unbootstrapped) throw new Error(unbootstrapped);

      phase = 'deploy';
      await runStreaming(
        'npx',
        buildCdkDeployArgs({ projectRoot: options.projectRoot, outputsFile: runOutputsFile, assemblyDir }),
        {
          ...cdkRun,
          onHostingUrl: (url) => {
            earlyHostingUrl = url;
            // Not the canonical BLOCKS_DEPLOYED line (that needs the API URL,
            // known only from the outputs read below). This is an early, greppable
            // frontend-URL line so a caller learns where the app lives even if
            // the process is killed before the deploy fully completes. Its label
            // deliberately differs from the final `🌐 Frontend URL:` line so a
            // naive grep does not match both — the early line says "converging".
            console.log(`\n🌐 Frontend deploying to: ${url}`);
          },
        },
      );
      runOutputs = readFileSync(runOutputsFile, 'utf-8');
    } catch (error) {
      // Terminal verdict on stdout: a caller that only captures stdout (the case
      // that produced phantom failures) must still be able to tell a failed
      // deploy from a killed process. This banner deliberately moved off stderr,
      // so grepping stderr for this exact string no longer matches — the failure
      // *reason* is still there. The CDK CLI keeps error-level output on stderr
      // even under `--ci`, and the entrypoint prints the error itself with
      // `console.error(error)`.
      if (phase !== 'bootstrap') cdkOutput.printRetained();
      console.log('\n❌ Deployment failed.');
      registerFrameworkFromSink(frameworkSink);
      throw error;
    } finally {
      publishAssembly(assemblyDir, outputDir);
      // This deploy's own directory: the mkdtemp result above, never a path from cdk.json.
      try {
        rmSync(assemblyDir, { recursive: true, force: true });
      } catch (error) {
        log.warn(`⚠️  Could not remove ${assemblyDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    registerFrameworkFromSink(frameworkSink);

    // This deploy's own outputs, never the shared document: a deploy of the same checkout that
    // overlaps with this one (another profile, another terminal) writes that one too.
    const outputs = JSON.parse(runOutputs);
    // Then the shared document, for the commands that read it later (the dashboard, the CLI's
    // console and status): replaced in one step, and only by a deploy that succeeded.
    const sharedOutputsFile = join(options.projectRoot, OUTPUTS_FILE.production);
    const pendingOutputsFile = `${sharedOutputsFile}.${process.pid}.tmp`;
    writeFileSync(pendingOutputsFile, runOutputs);
    renameSync(pendingOutputsFile, sharedOutputsFile);
    // `--all` can write more than one stack's outputs (e.g. the us-east-1
    // CloudFront-alarm monitoring stack). Pick the group that carries `ApiUrl`
    // — the main CDK Blocks stack, which also holds the Hosting outputs — rather
    // than relying on the write order of the outputs file. Falls back to the
    // first group so a single-stack app is unchanged.
    const stackGroups = Object.entries(outputs) as [string, Record<string, string>][];
    const [stack, stackOutputs] = stackGroups.find(([, group]) => group?.[BACKEND_OUTPUT_KEY]) ?? stackGroups[0] ?? ['', {}];
    const apiUrl = stackOutputs[BACKEND_OUTPUT_KEY];

    // Pair the frontend URL, build id, and invalidation id from the SAME
    // Hosting output group (see resolveHostingOutputs). `--wait-live` targets a
    // single-frontend stack; the first Hosting group is that frontend.
    const { hostingUrl, expectedBuildId, invalidationId } = resolveHostingOutputs(
      stackOutputs,
      earlyHostingUrl,
    );
    
    if (!apiUrl) {
      throw new Error('Could not find API URL in CDK outputs');
    }
    options.onDeployed?.({ stack, apiUrl, hostingUrl });
    
    // Record the API URL for explicit production targets, never in the dev server's config.json (see deployedConfigFile).
    writeDeployedConfig(join(options.projectRoot, '.cdk-blocks-sandbox'), 'production', apiUrl);

    console.log('\n✅ Deployment complete!');
    console.log(`\n📡 API URL: ${apiUrl}`);
    if (hostingUrl) {
      console.log(`🌐 Frontend URL: ${hostingUrl}`);
    }

    // Liveness gate: block until the deployed frontend serves the new build
    // before emitting the completion signal, so a caller's immediate self-test
    // can't hit a stale bundle. Skipped for a backend-only app (no hostingUrl)
    // and for the degenerate case of a frontend with no build-id output.
    if (waitLive && hostingUrl && expectedBuildId) {
      const timeoutMs = waitLiveTimeoutSec * 1000;
      log.progress(`\n⏳ Waiting for the new build to go live at ${hostingUrl} (up to ${timeoutMs / 1000}s)…`);

      // For a compute deploy, also wait on the fire-and-forget `/*`
      // invalidation. The output carries `<distributionId>/<invalidationId>`;
      // parseInvalidationId degrades a malformed/empty pair to the config-only
      // wait. Resolve the Region/profile the deploy itself used (SDK v3 clients
      // don't read cdk.json or AWS_DEFAULT_PROFILE — see resolveDeploymentTarget),
      // and load the CloudFront SDK lazily so a deploy without `--wait-live`, or
      // a pure-static one, never pays for it.
      let invalidationComplete: InvalidationProbe | undefined;
      let destroyClient: (() => void) | undefined;
      const parsedInvalidation = parseInvalidationId(invalidationId);
      if (parsedInvalidation) {
        const { distributionId, invId } = parsedInvalidation;
        const target = await resolveDeploymentTarget({ projectRoot: options.projectRoot });
        const { CloudFrontClient, GetInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
        const cloudfront = new CloudFrontClient({ region: target.region ?? undefined, profile: target.profile });
        destroyClient = () => cloudfront.destroy();
        invalidationComplete = makeInvalidationProbe(
          cloudfront,
          (DistributionId, Id) => new GetInvalidationCommand({ DistributionId, Id }),
          distributionId,
          invId,
        );
      }

      let result: WaitForLiveResult;
      try {
        result = await waitForLiveBuild({
          hostingUrl,
          expectedBuildId,
          invalidationComplete,
          timeoutMs,
          intervalMs: WAIT_LIVE_INTERVAL_MS,
          fetch: (url, reqTimeoutMs) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(reqTimeoutMs) }),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          onAttempt: ({ attempt, result: r, detail }) => {
            if (r !== 'live') {
              log.detail(`   …not live yet (attempt ${attempt}: ${r}${detail ? ` — ${detail}` : ''})`);
            }
          },
        });
      } finally {
        destroyClient?.();
      }

      if (!result.live) {
        // Not live: a terminal error (can never clear this deploy) names its
        // real cause; a timeout means the deploy succeeded but liveness is
        // unconfirmed. Either way exit non-zero rather than emit a false "live".
        if (result.reason === 'fatal') {
          console.log(
            `\n⚠️  Could not read the invalidation status: ${result.fatal}. The deploy itself ` +
              `SUCCEEDED, but build liveness can't be confirmed — grant cloudfront:GetInvalidation to ` +
              `the deploying credentials, or drop --wait-live.`,
          );
        } else {
          console.log(
            `\n⚠️  Could not confirm the new build is live after ${Math.round(result.elapsedMs / 1000)}s ` +
              `(${result.attempts} attempts). The deploy itself SUCCEEDED, but CloudFront may still be ` +
              `serving the previous build — re-check the frontend before trusting a self-test.`,
          );
        }
        console.log(`\n📡 API URL: ${apiUrl}`);
        if (hostingUrl) console.log(`🌐 Frontend URL: ${hostingUrl}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n✅ New build is live (confirmed in ${Math.round(result.elapsedMs / 1000)}s).`);
    } else if (waitLive && hostingUrl && !expectedBuildId) {
      // A frontend with no build-id output: the config poll has nothing to
      // match, so it would wait the whole budget and fail. Skip it with a note
      // rather than waste the time — re-synthesize to emit HostingBuildId.
      log.progress(
        '\nℹ️  --wait-live skipped: this stack emits no HostingBuildId output, so build liveness ' +
          'cannot be confirmed. Re-synthesize with the current hosting construct to enable it.',
      );
    }

    // Machine-readable completion signal — a single stable line a caller (a
    // coding agent, a CI step, a script) can grep for "deploy done + where it
    // lives" without parsing CloudFormation output or polling the stack. Always
    // the LAST line on the success path; with `--wait-live` it is emitted only
    // after the new build is confirmed live.
    console.log(`\n${formatDeploySignal(apiUrl, hostingUrl)}`);
  });
}
