// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { defineFrontDoor } from '@aws-cdk-blocks/hosting/constructs';
import { Hosting, BlocksStack, BlocksPresets, registerConfig } from 'aws-cdk-blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const suffix = process.env.BLOCKS_STACK_SUFFIX;

const stackName = sandboxMode
  ? `blocks-hosting-spa-${getSandboxId(projectRoot)}${suffix ? `-${suffix}` : ''}`
  : `blocks-hosting-spa-prod-${suffix || 'default'}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  // Disposable CI test stack: force the sandbox posture (DESTROY, no deletion
  // protection) so teardown works in every deploy mode. A real app would use
  // `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`.
  defaults: BlocksPresets.sandbox,
});

// HOSTING_FRONT_DOOR=app: a bring-your-own door that routes at the app
// (`routing: 'app'`). It attaches only the app's entry function, as the
// default route of an HTTP API, and the entry runs the whole route table:
// the static files, the SPA fallback, the same-origin API and the error pages.
const appRoutingDoor = defineFrontDoor({
  service: 'e2e-http-api',
  routing: 'app',
  build(scope, { origins }) {
    const api = new HttpApi(scope, 'AppRoutingApi', {
      defaultIntegration: new HttpLambdaIntegration('Entry', origins.entry.fn),
    });
    return { url: api.apiEndpoint };
  },
});

const frontDoor = (() => {
  switch (process.env.HOSTING_FRONT_DOOR) {
    case 'alb':
      return { kind: 'alb' as const };
    case 'app':
      return { kind: 'custom' as const, door: appRoutingDoor };
    default:
      return undefined;
  }
})();

// Hosting — SPA (static site). HOSTING_FRONT_DOOR=alb runs the same suite
// behind the regional ALB door (plain HTTP, its own VPC with no NAT gateway),
// HOSTING_FRONT_DOOR=app behind the app-routing door above; unset is the
// default CloudFront door.
new Hosting(blocksStack, 'Hosting', {
  root: join(__dirname, '..'),
  buildCommand: 'npm run build',
  buildOutputDir: 'dist',
  framework: 'spa',
  api: blocksStack,
  ...(frontDoor ? { frontDoor } : {}),
});

// Sandbox e2e only — see "Sandbox e2e test support" in `index.ts`. The flag
// is read here at synth and registered as config (`registerConfig`, which
// every compute loads into `process.env` before the backend module is
// imported), so the deployed backend builds the same `testSupport` namespace
// that synth did. The run's test-support secret travels the same way: the
// e2e `globalSetup` (or the CI workflow) sets `BLOCKS_TEST_SUPPORT_SECRET`
// before synth, and the deployed backend reads it from config.
if (process.env.BLOCKS_TEST_ENV === 'sandbox') {
  registerConfig(blocksStack, 'BLOCKS_TEST_ENV', 'sandbox');
  // `index.ts` already refused to load without it, so it is set here.
  registerConfig(blocksStack, 'BLOCKS_TEST_SUPPORT_SECRET', process.env.BLOCKS_TEST_SUPPORT_SECRET);
}

cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-hosting-spa');
cdk.Tags.of(blocksStack).add('blocks:front-door', process.env.HOSTING_FRONT_DOOR || 'cloudfront');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
cdk.Tags.of(blocksStack).add('blocks:created-at', new Date().toISOString().split('T')[0]);
