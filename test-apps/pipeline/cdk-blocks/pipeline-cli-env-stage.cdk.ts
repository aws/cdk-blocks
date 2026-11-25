// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Pipeline } from '@aws-cdk-blocks/core/cdk';

const app = new cdk.App();

// The pipeline runs in one environment and its stage deploys to another account
// and region. The app file passes CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION as
// its stack's `env`; the stack must still take the stage's environment.
const pipelineStack = new cdk.Stack(app, 'pipeline-cli-env-stage-test', {
  env: { account: '111111111111', region: 'eu-west-1' },
});

await Pipeline.create(pipelineStack, 'Pipeline', {
  appFile: './index-cli-env.cdk.ts',
  crossAccountKeys: true,
  source: {
    repo: 'test-org/test-repo',
    connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  },
  branches: [{
    branch: 'main',
    stages: [
      { name: 'beta', env: { account: '222222222222', region: 'ap-south-1' } },
    ],
  }],
});
