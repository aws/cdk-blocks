// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const CDK_OUT = join(APP_ROOT, 'cdk.out');

function synth(appFile = 'cdk-blocks/pipeline.cdk.ts') {
  rmSync(CDK_OUT, { recursive: true, force: true });
  execSync(
    `npx cdk synth --app "npx tsx -C cdk ${appFile}" --output cdk.out --quiet`,
    { cwd: APP_ROOT, stdio: 'pipe', timeout: 120_000 }
  );
}

/**
 * Synthesize by running the app the way the CDK CLI does, with a fixed CLI
 * environment. `cdk synth` exports its own CDK_DEFAULT_ACCOUNT and
 * CDK_DEFAULT_REGION to the app (from the credentials and Region it finds), so
 * a value set here would not reach the app through it.
 */
function synthWithCliEnvironment(appFile: string, cliEnv: { account: string; region: string }) {
  rmSync(CDK_OUT, { recursive: true, force: true });
  execSync(`npx tsx -C cdk ${appFile}`, {
    cwd: APP_ROOT,
    stdio: 'pipe',
    timeout: 120_000,
    env: {
      ...process.env,
      CDK_OUTDIR: CDK_OUT,
      CDK_DEFAULT_ACCOUNT: cliEnv.account,
      CDK_DEFAULT_REGION: cliEnv.region,
    },
  });
}

/** Recursively find all .template.json files under a directory. */
function findTemplates(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTemplates(full));
    } else if (entry.name.endsWith('.template.json')) {
      results.push(full);
    }
  }
  return results;
}

describe('Pipeline synth integration', () => {
  after(() => {
    rmSync(CDK_OUT, { recursive: true, force: true });
  });

  test('synth succeeds without errors (catches App-as-scope + path resolution + parasitic App bugs)', () => {
    // This single synth exercises ALL 3 regression classes:
    // 1. Pipeline.create(new App(), ...) — auto-Stack creation
    // 2. appFile: './index.cdk.ts' — caller-relative resolution
    // 3. Imported file creates its own App — beforeExit listener cleanup
    assert.doesNotThrow(() => synth());
  });

  test('produces cdk.out directory', () => {
    assert.ok(existsSync(CDK_OUT), 'cdk.out should exist after synth');
  });

  test('produces pipeline stack template', () => {
    const files = readdirSync(CDK_OUT);
    const templateFiles = files.filter(f => f.endsWith('.template.json'));
    assert.ok(templateFiles.length > 0, `Expected template files in cdk.out, found: ${files.join(', ')}`);
  });

  test('pipeline stack contains CodePipeline resource', () => {
    const files = readdirSync(CDK_OUT);
    const pipelineTemplate = files.find(f => f.includes('pipeline-synth-test') && f.endsWith('.template.json'));
    assert.ok(pipelineTemplate, 'Pipeline stack template should exist');

    const template = JSON.parse(readFileSync(join(CDK_OUT, pipelineTemplate), 'utf-8'));
    const resources = template.Resources || {};
    const resourceTypes = Object.values(resources).map((r: any) => r.Type);

    assert.ok(
      resourceTypes.includes('AWS::CodePipeline::Pipeline'),
      `Expected AWS::CodePipeline::Pipeline resource, found types: ${[...new Set(resourceTypes)].join(', ')}`
    );
  });

  test('synth CodeBuild project declares Node.js 22 runtime by default (partialBuildSpec)', () => {
    const files = readdirSync(CDK_OUT);
    const pipelineTemplate = files.find(f => f.includes('pipeline-synth-test') && f.endsWith('.template.json'));
    assert.ok(pipelineTemplate, 'Pipeline stack template should exist');

    const template = JSON.parse(readFileSync(join(CDK_OUT, pipelineTemplate), 'utf-8'));
    const resources = template.Resources || {};
    const buildSpecs = Object.values(resources)
      .filter((r: any) => r.Type === 'AWS::CodeBuild::Project')
      .map((r: any) => r.Properties?.Source?.BuildSpec)
      .filter((b: unknown): b is string => typeof b === 'string');

    const synthSpec = buildSpecs.find(b => b.includes('runtime-versions'));
    assert.ok(synthSpec, `Expected a synth buildspec declaring runtime-versions, found ${buildSpecs.length} buildspec(s)`);

    const parsed = JSON.parse(synthSpec);
    assert.strictEqual(
      parsed.phases?.install?.['runtime-versions']?.nodejs,
      22,
      'Synth buildspec should declare the Node.js 22 runtime by default (partialBuildSpec)',
    );
  });

  test('stage stacks are synthesized (ambient scope worked)', () => {
    // CDK Pipelines puts stage stacks in nested assembly directories
    const allTemplates = findTemplates(CDK_OUT);
    const relPaths = allTemplates.map(t => relative(CDK_OUT, t));
    const stageTemplates = allTemplates.filter(t => t.includes('beta'));
    assert.ok(
      stageTemplates.length > 0,
      `Expected stage template paths containing 'beta', found: ${relPaths.join(', ')}`
    );
  });

  test('stage stack contains Lambda function (BlocksStack imported correctly)', () => {
    const allTemplates = findTemplates(CDK_OUT);
    const stageTemplate = allTemplates.find(t => t.includes('beta'));
    if (!stageTemplate) {
      assert.fail('No beta stage template found');
      return;
    }

    const template = JSON.parse(readFileSync(stageTemplate, 'utf-8'));
    const resources = template.Resources || {};
    const resourceTypes = Object.values(resources).map((r: any) => r.Type);

    assert.ok(
      resourceTypes.includes('AWS::Lambda::Function'),
      `Expected Lambda function in stage stack, found: ${[...new Set(resourceTypes)].join(', ')}`
    );
  });

  test('deterministic output (synth twice produces same result)', () => {
    synth();
    const templates1 = findTemplates(CDK_OUT)
      .map(t => relative(CDK_OUT, t))
      .sort();
    const contents1 = templates1.map(t => readFileSync(join(CDK_OUT, t), 'utf-8'));

    synth();
    const templates2 = findTemplates(CDK_OUT)
      .map(t => relative(CDK_OUT, t))
      .sort();
    const contents2 = templates2.map(t => readFileSync(join(CDK_OUT, t), 'utf-8'));

    assert.deepStrictEqual(templates1, templates2, 'Template file list should be identical across synths');
    assert.deepStrictEqual(contents1, contents2, 'Template contents should be identical across synths');
  });
});

describe('Pipeline synth with default appFile', () => {
  after(() => {
    rmSync(CDK_OUT, { recursive: true, force: true });
  });

  test('synth succeeds with default appFile (no explicit appFile or stageFactory)', () => {
    assert.doesNotThrow(() => synth('cdk-blocks/pipeline-default.cdk.ts'));
  });

  test('default appFile produces pipeline stack with CodePipeline resource', () => {
    const files = readdirSync(CDK_OUT);
    const pipelineTemplate = files.find(f => f.includes('pipeline-default-test') && f.endsWith('.template.json'));
    assert.ok(pipelineTemplate, 'Pipeline default stack template should exist');

    const template = JSON.parse(readFileSync(join(CDK_OUT, pipelineTemplate), 'utf-8'));
    const resources = template.Resources || {};
    const resourceTypes = Object.values(resources).map((r: any) => r.Type);

    assert.ok(
      resourceTypes.includes('AWS::CodePipeline::Pipeline'),
      `Expected AWS::CodePipeline::Pipeline resource, found types: ${[...new Set(resourceTypes)].join(', ')}`
    );
  });

  test('default appFile resolves to sibling index.cdk.ts (stage stack is synthesized)', () => {
    const allTemplates = findTemplates(CDK_OUT);
    const relPaths = allTemplates.map(t => relative(CDK_OUT, t));
    const stageTemplates = allTemplates.filter(t => t.includes('beta'));
    assert.ok(
      stageTemplates.length > 0,
      `Expected stage template paths containing 'beta', found: ${relPaths.join(', ')}`
    );
  });

  test('default appFile stage stack contains Lambda function', () => {
    const allTemplates = findTemplates(CDK_OUT);
    const stageTemplate = allTemplates.find(t => t.includes('beta'));
    if (!stageTemplate) {
      assert.fail('No beta stage template found');
      return;
    }

    const template = JSON.parse(readFileSync(stageTemplate, 'utf-8'));
    const resources = template.Resources || {};
    const resourceTypes = Object.values(resources).map((r: any) => r.Type);

    assert.ok(
      resourceTypes.includes('AWS::Lambda::Function'),
      `Expected Lambda function in stage stack, found: ${[...new Set(resourceTypes)].join(', ')}`
    );
  });
});

// ---------------------------------------------------------------------------
// Deploy action → assembly artifact validation
// ---------------------------------------------------------------------------

interface DeployAction {
  stageName: string;
  actionName: string;
  stackName: string;
  templatePath?: string;
}

/**
 * Extract all CloudFormation deploy actions from a CodePipeline resource.
 * Returns the stack name and template path referenced by each action.
 */
function extractDeployActions(template: any): DeployAction[] {
  const actions: DeployAction[] = [];
  const resources = template.Resources || {};
  for (const res of Object.values(resources) as any[]) {
    if (res.Type !== 'AWS::CodePipeline::Pipeline') continue;
    for (const stage of res.Properties?.Stages ?? []) {
      for (const action of stage.Actions ?? []) {
        const provider = action.ActionTypeId?.Provider;
        if (provider !== 'CloudFormation') continue;
        const config = action.Configuration ?? {};
        if (!config.StackName) continue;
        actions.push({
          stageName: stage.Name,
          actionName: action.Name,
          stackName: config.StackName,
          templatePath: config.TemplatePath,
        });
      }
    }
  }
  return actions;
}

/**
 * Recursively collect all stack artifact IDs and their stackNames from
 * manifest.json files in the cloud assembly (including nested assemblies).
 */
function collectStackArtifacts(assemblyDir: string): { artifactId: string; stackName: string; templateFile: string; environment: string }[] {
  const results: { artifactId: string; stackName: string; templateFile: string; environment: string }[] = [];
  const manifestPath = join(assemblyDir, 'manifest.json');
  if (!existsSync(manifestPath)) return results;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  for (const [id, artifact] of Object.entries(manifest.artifacts ?? {}) as [string, any][]) {
    if (artifact.type === 'aws:cloudformation:stack') {
      results.push({
        artifactId: id,
        stackName: artifact.properties?.stackName ?? id,
        templateFile: join(assemblyDir, artifact.properties?.templateFile ?? `${id}.template.json`),
        environment: artifact.environment,
      });
    } else if (artifact.type === 'cdk:cloud-assembly') {
      const nestedDir = join(assemblyDir, artifact.properties?.directoryName ?? id);
      results.push(...collectStackArtifacts(nestedDir));
    }
  }
  return results;
}

describe('Deploy actions reference actual assembly stacks', () => {
  after(() => {
    rmSync(CDK_OUT, { recursive: true, force: true });
  });

  test('synth pipeline for deploy-action validation', () => {
    synth();
    assert.ok(existsSync(CDK_OUT));
  });

  test('every deploy action TemplatePath references an existing file in the assembly', () => {
    const files = readdirSync(CDK_OUT);
    const pipelineTemplate = files.find(f => f.includes('pipeline-synth-test') && f.endsWith('.template.json'));
    assert.ok(pipelineTemplate, 'Pipeline stack template should exist');

    const template = JSON.parse(readFileSync(join(CDK_OUT, pipelineTemplate), 'utf-8'));
    const actions = extractDeployActions(template);
    assert.ok(actions.length > 0, 'Expected at least one CloudFormation deploy action in the pipeline');

    const actionsWithTemplate = actions.filter(a => a.templatePath);
    assert.ok(actionsWithTemplate.length > 0, 'Expected at least one action with a TemplatePath');

    const missing: string[] = [];
    for (const action of actionsWithTemplate) {
      // TemplatePath format: "<InputArtifact>::<relative-path>"
      const parts = action.templatePath!.split('::');
      const relativePath = parts.length > 1 ? parts[1] : parts[0];
      const fullPath = join(CDK_OUT, relativePath);
      if (!existsSync(fullPath)) {
        missing.push(
          `Stage "${action.stageName}" action "${action.actionName}" references ` +
          `template "${relativePath}" which does not exist in the assembly`
        );
      }
    }
    assert.strictEqual(
      missing.length, 0,
      `Deploy actions reference non-existent templates:\n${missing.join('\n')}`
    );
  });

  test('every deploy action StackName matches a stack artifact in the assembly', () => {
    const files = readdirSync(CDK_OUT);
    const pipelineTemplate = files.find(f => f.includes('pipeline-synth-test') && f.endsWith('.template.json'));
    assert.ok(pipelineTemplate, 'Pipeline stack template should exist');

    const template = JSON.parse(readFileSync(join(CDK_OUT, pipelineTemplate), 'utf-8'));
    const actions = extractDeployActions(template);
    assert.ok(actions.length > 0, 'Expected at least one CloudFormation deploy action');

    const stackArtifacts = collectStackArtifacts(CDK_OUT);
    const knownStackNames = new Set(stackArtifacts.map(s => s.stackName));

    // Deduplicate — Prepare and Deploy actions reference the same StackName
    const uniqueStackNames = [...new Set(actions.map(a => a.stackName))];

    const unmatched: string[] = [];
    for (const name of uniqueStackNames) {
      if (!knownStackNames.has(name)) {
        unmatched.push(
          `StackName "${name}" is referenced by deploy actions but no stack artifact ` +
          `with that name exists in the assembly. Known stacks: [${[...knownStackNames].join(', ')}]`
        );
      }
    }
    assert.strictEqual(
      unmatched.length, 0,
      `Deploy actions reference stacks not found in assembly:\n${unmatched.join('\n')}`
    );
  });

  test('every stack artifact in the assembly has an actual template file on disk', () => {
    const stackArtifacts = collectStackArtifacts(CDK_OUT);
    assert.ok(stackArtifacts.length > 0, 'Expected at least one stack artifact in the assembly');

    const missing: string[] = [];
    for (const artifact of stackArtifacts) {
      if (!existsSync(artifact.templateFile)) {
        missing.push(
          `Stack artifact "${artifact.artifactId}" (stackName: ${artifact.stackName}) ` +
          `references template file "${artifact.templateFile}" which does not exist`
        );
      }
    }
    assert.strictEqual(
      missing.length, 0,
      `Stack artifacts with missing template files:\n${missing.join('\n')}`
    );
  });
});

// ---------------------------------------------------------------------------
// App file that passes the CDK CLI's environment to its stack
// ---------------------------------------------------------------------------

describe('Pipeline synth when the app file passes CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION as env', () => {
  // The environment the CDK CLI runs the pipeline in: not the stage's.
  const CLI_ENV = { account: '111111111111', region: 'eu-west-1' };

  /** The environment of the app's stack (`pipeline-test-prod` in index-cli-env.cdk.ts) in the synthesized assembly. */
  function appStackEnvironment(): string {
    const stacks = collectStackArtifacts(CDK_OUT);
    const appStack = stacks.find(s => s.stackName.endsWith('pipeline-test-prod'));
    assert.ok(appStack, `Expected the app's stack in the assembly, found: ${stacks.map(s => s.stackName).join(', ')}`);
    return appStack.environment;
  }

  after(() => {
    rmSync(CDK_OUT, { recursive: true, force: true });
  });

  test("the app's stack takes the environment of a stage that sets env", () => {
    synthWithCliEnvironment('cdk-blocks/pipeline-cli-env-stage.cdk.ts', CLI_ENV);
    assert.strictEqual(appStackEnvironment(), 'aws://222222222222/ap-south-1');
  });

  test('an environment-agnostic pipeline whose stage sets no env synthesizes, with an environment-agnostic app stack', () => {
    // With the CLI's environment on the app's stack, synth fails with
    // PipelineStackMustHaveExplicitRegion: the agnostic pipeline stack would
    // deploy a stack pinned to an account and Region.
    assert.doesNotThrow(() => synthWithCliEnvironment('cdk-blocks/pipeline-cli-env-agnostic.cdk.ts', CLI_ENV));
    assert.strictEqual(appStackEnvironment(), 'aws://unknown-account/unknown-region');
  });
});
