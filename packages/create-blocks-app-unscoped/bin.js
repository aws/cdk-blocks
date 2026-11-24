#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// `create-blocks-app` is the unscoped name of @aws-cdk-blocks/create-blocks-app, so that
// `npm create blocks-app` works. It runs that package's CLI with the same arguments.
// The CLI runs as a child process because it starts only when it is the entry point.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const cli = createRequire(import.meta.url).resolve('@aws-cdk-blocks/create-blocks-app/dist/index.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });

// Ctrl+C reaches the CLI directly, because it shares this terminal. Stay alive until the CLI exits.
process.on('SIGINT', () => {});
// These reach this process only, so pass them on.
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    // End by the same signal as the CLI, so the caller sees how it ended.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
