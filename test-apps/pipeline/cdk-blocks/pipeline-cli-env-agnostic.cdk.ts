// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Pipeline } from '@aws-cdk-blocks/core/cdk';

const app = new cdk.App();

// An environment-agnostic pipeline whose stage sets no `env`. The app file
// passes CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION as its stack's `env`; the
// stack must stay environment-agnostic, or the pipeline stack would need an
// explicit environment of its own to deploy it.
await Pipeline.create(app, 'pipeline-cli-env-agnostic-test', {
  appFile: './index-cli-env.cdk.ts',
  source: {
    repo: 'test-org/test-repo',
    connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  },
  branches: [{
    branch: 'main',
    stages: [
      { name: 'beta' },
    ],
  }],
});
