// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// index.cdk.ts with the CDK CLI's environment passed to the stack as `env`.
// Deployed on its own, the stack lands where the CLI deploys. Imported by a
// pipeline, it must take the environment of the stage it is imported for.

import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from 'aws-cdk-blocks/cdk';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();
const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const stackName = sandboxMode ? 'pipeline-test-sandbox' : 'pipeline-test-prod';

await BlocksStack.create(app, stackName, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production,
});
