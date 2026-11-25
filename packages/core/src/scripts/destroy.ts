// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadProductionEnv } from './ensure-secrets.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { type DeploymentTargetOptions, deploymentClientCredentials, resolveDeploymentTarget } from './deployment-target.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { createCdkOutput } from './cdk-output.js';
import { migrateLegacyDeployedConfig } from './deployed-config.js';
import { migrateLegacySandboxDir } from './migrate-sandbox-dir.js';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ignoreClosedOutput, log } from './log.js';
import { runCapture } from './run-command.js';
import { REUSE_FRONTEND_BUILD_CONTEXT } from '../common/frontend-build.js';
import {
  type AssemblyStack,
  type AssemblyStackNode,
  type DestroyRetryDeps,
  type EmptyBucketsClients,
  destroyRetryClients,
  destroyWasThrottled,
  deterministicDestroyFailure,
  emptyUndeletedBuckets,
  inVerifiedAccount,
  outOfAccountWarning,
  runDestroyWithRetries,
  snapshotStackEvents,
  topLevelStackNodes,
} from './sandbox.js';
import { acquireSynthLock } from './synth-lock.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
  /**
   * The production stack the caller expects to delete, for example `<stackId>-prod`.
   * The destroy refuses when the CDK app does not define a stack with this name.
   * It deletes that stack and Hosting's CloudFront monitoring stacks for it (see
   * {@link selectProductionStacks}), and reports "nothing to delete" instead of
   * running `cdk destroy` when none of them exists in its Region: `cdk destroy`
   * treats a missing stack as a successful no-op. Without it, the app must
   * define exactly one stack, which is the one deleted.
   */
  stackName?: string;
  /** How the user runs the destroy, in the guidance. Default: `npm run destroy`. */
  invocation?: string;
}

/** The slice of a CloudFormation client that {@link stackExists} needs. */
export interface DescribeStacksClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * Whether CloudFormation has a stack named `stackName`: `false` only for the
 * `ValidationError` "Stack with id … does not exist"; `undefined` when the
 * request fails otherwise (for example AccessDenied), so the caller goes on and
 * `cdk destroy` reports any real error.
 */
export async function stackExists(
  cfn: DescribeStacksClient,
  describeStacks: (stackName: string) => unknown,
  stackName: string,
): Promise<boolean | undefined> {
  try {
    await cfn.send(describeStacks(stackName));
    return true;
  } catch (error) {
    const { name, message } = error instanceof Error ? error : { name: '', message: String(error) };
    return name === 'ValidationError' && /does not exist/.test(message) ? false : undefined;
  }
}

export interface DeployedStackOptions extends DeploymentTargetOptions {
  stackName: string;
  /** The Region to look in. Default: the Region CDK deploys to. */
  region?: string;
}

/**
 * Whether CloudFormation has the stack, looked up with the credentials and Region
 * CDK deploys with (see `assertAwsCredentials` and `deploymentClientCredentials`):
 * CDK uses environment access keys before AWS_PROFILE, and SDK clients do not read
 * `cdk.json`. `false` only when the stack does not exist; `undefined` without a
 * Region, or when the lookup fails otherwise (no credentials, AccessDenied, no network).
 */
export async function deployedStackExists(options: DeployedStackOptions): Promise<boolean | undefined> {
  const target = await resolveDeploymentTarget(options);
  const region = options.region ?? target.region;
  if (!region) return undefined;
  // Loaded only when a lookup runs, like the other SDK clients of the scripts.
  const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
  const cfn = new CloudFormationClient({ region, ...deploymentClientCredentials(target, options.env), maxAttempts: 2 });
  try {
    return await stackExists(cfn, (StackName) => new DescribeStacksCommand({ StackName }), options.stackName);
  } finally {
    cfn.destroy();
  }
}

/**
 * CDK context every synth of a destroy passes: a destroy doesn't deploy the
 * frontend, so `Hosting` reuses an existing frontend build instead of running
 * `buildCommand` and the framework build (see common/frontend-build.ts).
 */
export const DESTROY_SYNTH_CONTEXT: readonly string[] = ['--context', `${REUSE_FRONTEND_BUILD_CONTEXT}=true`];

/**
 * The prefix of the directory, inside the project's {@link BLOCKS_SANDBOX_DIR},
 * where one `npm run destroy` synthesizes the app. The stacks to delete are
 * read from that assembly and `cdk destroy --app` deletes from it, so what is
 * deleted is what was checked. Each destroy makes its own directory
 * (`mkdtemp`): a second destroy of the same checkout (another profile, another
 * terminal) can't replace the assembly between the check and the delete. It is
 * inside the project so that the app resolves its modules and assets as in
 * any other synth.
 */
export const PRODUCTION_DESTROY_ASSEMBLY_PREFIX = 'destroy-';

/** The Region of Hosting's CloudFront monitoring stack: `AWS/CloudFront` metrics exist only there. */
const MONITORING_STACK_REGION = 'us-east-1';

/**
 * A stack selector the CDK CLI reads as that one id. The CLI matches selectors
 * as glob patterns, so an id with a pattern character could select other stacks.
 */
const LITERAL_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;

/** What a production destroy deletes and what it leaves in place. */
export interface ProductionDestroySelection {
  /** The app stack, then its CloudFront monitoring stacks: the only stacks `cdk destroy` is given. */
  stacks: AssemblyStackNode[];
  /** The stacks the app stack depends on, directly or not. The destroy never deletes them. */
  upstream: AssemblyStackNode[];
}

/** A stack as `cdk ls` prints it: its id, followed by `(name)` when the stack name differs. */
function stackLabel(stack: AssemblyStackNode): string {
  return stack.stackName === stack.id ? stack.selector : `${stack.selector} (${stack.stackName})`;
}

/**
 * Choose the stacks a production destroy deletes, from the top-level stacks of
 * the synthesized app (see {@link topLevelStackNodes}). Throws, before anything
 * is deleted, when the choice is not safe.
 *
 * `cdk destroy` acts on the stacks the app defines, not on the name the caller
 * printed and confirmed, so the app must define `stackName`: an app whose
 * `index.cdk.ts` names its stack differently (an app created before
 * `.cdk-blocks/config.json`, or a stackId that does not match) would delete
 * another stack than the one named.
 *
 * Besides the app stack, only the stack `Hosting` adds for the CloudFront 5xx
 * alarm is deleted: one that depends on the app stack, is named
 * `<stackName>-CfMonitoring-<8 hex>` and is in us-east-1. Any other stack that
 * depends on the app stack, directly or through another stack, stops the
 * destroy: CloudFormation can't delete the app stack under it, and it is not
 * this command's to delete. The stacks the app stack depends on (a Lambda@Edge
 * `edge-lambda-stack-*`, a VPC lookup stack, a stack another app shares) are
 * returned as `upstream` and never deleted.
 *
 * @internal
 */
export function selectProductionStacks(
  nodes: AssemblyStackNode[],
  stackName: string | undefined,
  invocation = 'npm run destroy',
): ProductionDestroySelection {
  const defined = nodes.length > 0 ? nodes.map(stackLabel).join(', ') : 'no stack';
  let app: AssemblyStackNode;
  if (stackName) {
    const named = nodes.filter((node) => node.stackName === stackName);
    if (named.length === 0) {
      throw new Error(
        `The CDK app (cdk-blocks/index.cdk.ts) defines ${defined}, ` +
          `not ${stackName}, the production stack that .cdk-blocks/config.json names; nothing was deleted. ` +
          `Set "stackId" in .cdk-blocks/config.json so that <stackId>-prod is the app's production stack, ` +
          `or name the stack in index.cdk.ts with getStackName().`,
      );
    }
    if (named.length > 1) {
      throw new Error(
        `The CDK app (cdk-blocks/index.cdk.ts) defines ${named.length} stacks named ${stackName} ` +
          `(${named.map((node) => `${node.selector} in ${node.region ?? 'the default Region'}`).join(', ')}), ` +
          `and \`${invocation}\` deletes one production stack; nothing was deleted. ` +
          `Delete each of them by its id with \`cdk destroy\`.`,
      );
    }
    app = named[0];
  } else {
    if (nodes.length !== 1) {
      throw new Error(
        `The CDK app (cdk-blocks/index.cdk.ts) defines ${defined}, and the destroy was not given the ` +
          `production stack to delete; nothing was deleted. Pass \`stackName\` to destroy().`,
      );
    }
    app = nodes[0];
  }

  // Every stack that depends on the app stack, directly or through another stack.
  const dependentIds = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of nodes) {
      if (node.id === app.id || dependentIds.has(node.id)) continue;
      if (node.dependencies.some((id) => id === app.id || dependentIds.has(id))) {
        dependentIds.add(node.id);
        grew = true;
      }
    }
  }
  const dependents = nodes.filter((node) => dependentIds.has(node.id));
  const monitoringName = new RegExp(`^${app.stackName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-CfMonitoring-[0-9a-f]{8}$`);
  const foreign = dependents.filter(
    (node) =>
      !(node.dependencies.includes(app.id) && monitoringName.test(node.stackName) && node.region === MONITORING_STACK_REGION),
  );
  if (foreign.length > 0) {
    const names = foreign.map(stackLabel).join(', ');
    throw new Error(
      `${names} ${foreign.length === 1 ? 'depends' : 'depend'} on ${app.stackName}, and \`${invocation}\` deletes only ` +
        `${app.stackName} and the CloudFront monitoring stack that Hosting adds for it; nothing was deleted. ` +
        `Delete ${names} first, then re-run \`${invocation}\`.`,
    );
  }

  const stacks = [app, ...dependents];
  const unselectable = stacks.filter((stack) => !LITERAL_SELECTOR.test(stack.selector));
  if (unselectable.length > 0) {
    throw new Error(
      `\`${invocation}\` can't select ${unselectable.map(stackLabel).join(', ')}: the CDK CLI reads a stack id ` +
        `with a character outside letters, digits, "_", ".", "/" and "-" as a pattern, which could match another ` +
        `stack; nothing was deleted. Delete the stack in the CloudFormation console.`,
    );
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selectedIds = new Set(stacks.map((stack) => stack.id));
  const upstreamIds = new Set<string>();
  const pending = stacks.flatMap((stack) => stack.dependencies);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (selectedIds.has(id) || upstreamIds.has(id)) continue;
    upstreamIds.add(id);
    pending.push(...(byId.get(id)?.dependencies ?? []));
  }
  return { stacks, upstream: nodes.filter((node) => upstreamIds.has(node.id)) };
}

/**
 * Synthesize the production app once into `assemblyDir` and return its
 * top-level stacks.
 */
function synthesizeProductionStacks(options: DestroyOptions, cdkEnv: NodeJS.ProcessEnv, assemblyDir: string): AssemblyStackNode[] {
  // A synth stages the frontend in directories every command of the checkout shares (see synth-lock.ts).
  const synthLock = acquireSynthLock(options.projectRoot, options.invocation ?? 'npm run destroy');
  try {
    // runCapture (cross-platform, captures stderr): the synth's own output is not the destroy's.
    runCapture(
      'npx',
      [
        'cdk', 'synth',
        '--quiet',
        '--output', assemblyDir,
        '--context', `projectRoot=${options.projectRoot}`,
        ...DESTROY_SYNTH_CONTEXT,
      ],
      { cwd: options.projectRoot, env: cdkEnv },
    );
  } catch (e) {
    const stderr = e instanceof Error && 'stderr' in e ? String(e.stderr ?? '') : '';
    const detail = stderr || (e instanceof Error ? e.message : String(e));
    throw new Error(`Could not synthesize the CDK app with 'cdk synth' to find its stacks, so nothing was deleted: ${detail}`);
  } finally {
    synthLock.release();
  }
  return topLevelStackNodes(assemblyDir);
}

export async function destroy(options: DestroyOptions) {
  ignoreClosedOutput();
  return trackCommand('destroy', async () => {
    log.progress('🗑️  Destroying production stack...');
    migrateLegacySandboxDir(options.projectRoot);
    migrateLegacyDeployedConfig(join(options.projectRoot, BLOCKS_SANDBOX_DIR));

    // The same environment as the production deploy: `.env.production` can set
    // AWS_PROFILE and AWS_REGION (an exported variable wins), so without it the
    // destroy could target other credentials or another Region than the deploy.
    loadProductionEnv();
    process.env.BLOCKS_STAGE = 'production';

    // Fail fast on a missing/expired credential BEFORE entering the retry loop:
    // a credential error is deterministic, so retrying it only burns the full
    // [60s, 120s] backoff (the Telemetry E2E timeout this guards against). The
    // retry loop is for transient teardown blockers (bucket-blocked delete,
    // DeleteRestApi 429 throttle, ENI detach), never auth. A missing Region
    // stops it too: the check would otherwise be skipped, and CDK's failure
    // (`UnresolvedAccount`) retried.
    const verified = await assertAwsCredentials({
      command: 'destroy',
      invocation: options.invocation,
      projectRoot: options.projectRoot,
      accountDetails: false,
      requireRegion: true,
    });

    const cdkEnv = {
      ...process.env,
      NODE_OPTIONS: '--conditions=cdk',
      ...getCdkTelemetryEnv('production'),
    };

    // This destroy's own assembly directory (see PRODUCTION_DESTROY_ASSEMBLY_PREFIX),
    // removed whatever the outcome: a retry of a failed destroy synthesizes again.
    const sandboxDir = resolve(options.projectRoot, BLOCKS_SANDBOX_DIR);
    mkdirSync(sandboxDir, { recursive: true });
    const assemblyDir = mkdtempSync(join(sandboxDir, PRODUCTION_DESTROY_ASSEMBLY_PREFIX));
    try {
      // One synth: the stacks are chosen from this assembly, and `cdk destroy`
      // deletes from it (see productionDestroyDeps), never from a second synth.
      const selection = selectProductionStacks(
        synthesizeProductionStacks(options, cdkEnv, assemblyDir),
        options.stackName,
        options.invocation,
      );
      const target = await resolveDeploymentTarget({ projectRoot: options.projectRoot });
      const place = (stack: AssemblyStack): string => `${stack.stackName} in Region ${stack.region ?? target.region}`;
      // This destroy's own AWS calls go only to the account STS verified (see inVerifiedAccount):
      // any other stack is unknown, never "not there", and `cdk destroy` still gets it.
      const account = verified?.account;
      const skipped = [...selection.stacks, ...selection.upstream].filter((stack) => !inVerifiedAccount(stack, account));
      if (skipped.length > 0) log.warn(outOfAccountWarning(skipped, account));
      const exists = async (stack: AssemblyStackNode): Promise<boolean | undefined> =>
        inVerifiedAccount(stack, account)
          ? deployedStackExists({ projectRoot: options.projectRoot, stackName: stack.stackName, region: stack.region })
          : undefined;
      const [app, ...monitoring] = selection.stacks;

      if (options.stackName) {
        const found = await Promise.all(selection.stacks.map(exists));
        if (found.every((stackFound) => stackFound === false)) {
          console.log(`\nℹ️  There is no stack ${selection.stacks.map(place).join(', and no stack ')}; nothing to delete.`);
          return;
        }
        // A destroy that stopped after the app stack, or an app stack deleted by hand: finish it.
        const left = monitoring.filter((_, index) => found[index + 1] === true);
        if (found[0] === false && left.length > 0) {
          console.log(`\nℹ️  There is no stack ${place(app)}; deleting what is left of the app: ${left.map(place).join(', ')}.`);
        }
      }
      // The order CDK deletes in: a stack that depends on another goes first.
      log.progress(`   Deleting ${[...monitoring, app].map(place).join(', then ')}`);

      // Reuse the sandbox path's shipped teardown-retry machinery: on a failed
      // destroy, empty the stacks' versioned S3 buckets (the autoDeleteObjects
      // Lambda never provisions on a failed CREATE, so the bucket blocks the
      // delete and the stack + its IAM roles leak) and back off before retrying.
      // The backoff also rides out a transient API Gateway control-plane throttle
      // (DeleteRestApi 429), which single-shot `cdk destroy` surfaced as a hard
      // teardown failure with no recovery. A failure whose stack events show such
      // a throttle gets a longer, jittered backoff (see runDestroyWithRetries).
      const clients = await destroyRetryClients(options.projectRoot);
      await runDestroyWithRetries(
        productionDestroyDeps(options, cdkEnv, { assemblyDir, stacks: selection.stacks, account }, clients),
      );

      // What the app stack depended on is still there, unless it was never deployed (a lookup-only stack).
      const upstreamFound = await Promise.all(selection.upstream.map(exists));
      const remaining = selection.upstream.filter((_, index) => upstreamFound[index] !== false);
      if (remaining.length > 0) {
        console.log(
          [
            `\nℹ️  Not deleted: ${app.stackName} depended on ${remaining.length === 1 ? 'this stack' : 'these stacks'}, ` +
              `which \`${options.invocation ?? 'npm run destroy'}\` never deletes:`,
            ...remaining.map((stack) => `     ${place(stack)}`),
            '   To delete one that nothing else uses, run from the project directory:',
            ...remaining.map((stack) => `     NODE_OPTIONS="--conditions=cdk" npx cdk destroy --exclusively ${stack.selector}`),
          ].join('\n'),
        );
      }
    } finally {
      rmSync(assemblyDir, { recursive: true, force: true });
    }
  });
}

/**
 * The {@link runDestroyWithRetries} dependencies the production `destroy`
 * runs with. A separate function so a test can pin the wiring (the stack
 * selection, throttle detection, bucket emptying) without spawning cdk.
 * `clients` are the AWS clients the retry uses (see {@link destroyRetryClients}).
 *
 * `cdk destroy` gets the assembly that `stacks` were read from (`--app
 * <assemblyDir>`: no second synth) and those stacks by id, with
 * `--exclusively`: without it the CLI adds every stack that depends on a
 * selected one. Never `--all`, which would delete every stack the app defines,
 * also one it shares with another app. CDK deletes a stack that depends on
 * another selected stack first, so the us-east-1 monitoring stack goes before
 * the app stack it reads the distribution id from.
 *
 * The retry's own AWS calls are made only for the stacks in `account`, the
 * account the credential check verified (see {@link inVerifiedAccount});
 * `cdk destroy` gets every stack. Before a retry it empties only the buckets
 * that CloudFormation could not delete in the failed attempt because they
 * hold objects (see `emptyUndeletedBuckets`): a production stack retains its
 * data buckets, and the retry must never empty one of those. The attempt's
 * events are those after each stack's newest event before it.
 */
export function productionDestroyDeps(
  options: DestroyOptions,
  cdkEnv: NodeJS.ProcessEnv,
  selected: { assemblyDir: string; stacks: AssemblyStackNode[]; account: string | undefined },
  clients: Required<EmptyBucketsClients>,
): DestroyRetryDeps {
  const cdkArgs = [
    'cdk', 'destroy',
    '--app', selected.assemblyDir,
    // No build command: the CLI would run cdk.json's `build` again for an assembly (see buildCdkDeployArgs).
    '--build=',
    '--exclusively',
    ...selected.stacks.map((stack) => stack.selector),
    '--force',
  ];
  // At BLOCKS_LOG_LEVEL=quiet|normal the CDK stream is condensed and retained;
  // the retry loop prints it once the destroy finally fails.
  const cdkOutput = createCdkOutput({ label: 'cdk destroy', verb: 'destroy' });
  // Each stack with its own Region: the monitoring stack is in us-east-1, whatever the app's Region.
  const listStacks = (): AssemblyStack[] =>
    selected.stacks
      .filter((stack) => inVerifiedAccount(stack, selected.account))
      .map(({ stackName, region }) => ({ stackName, region }));
  let eventsBefore: ReadonlyMap<string, string> = new Map();
  return {
    beforeAttempt: async () => {
      eventsBefore = await snapshotStackEvents(listStacks(), clients.cfnFor);
    },
    runDestroy: () => cdkOutput.run('npx', cdkArgs, { cwd: options.projectRoot, env: cdkEnv, deferSignals: true }),
    printRetainedOutput: () => cdkOutput.printRetained(),
    attemptOutput: () => cdkOutput.lastRunOutput(),
    listStacks,
    emptyBuckets: (stacks) => emptyUndeletedBuckets(stacks, eventsBefore, clients, selected.account),
    isThrottled: (stacks, since, previous) => destroyWasThrottled(stacks, since, previous, clients.cfnFor),
    deterministicFailure: () => deterministicDestroyFailure(cdkOutput.lastRunOutput()),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    successLabel: 'Production stack',
  };
}
