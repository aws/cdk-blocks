// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, 'bin.js');
const SCOPED_NAME = '@aws-cdk-blocks/create-blocks-app';
const SCOPED_DIR = join(here, '../create-blocks-app');
const SCOPED_CLI = join(SCOPED_DIR, 'dist/index.js');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

// Every run starts the real CLI, which calls trackCommand. Opt out, and point the
// endpoint at a dead port so a regression cannot reach the production collector.
const env = {
  ...process.env,
  CDK_DISABLE_CLI_TELEMETRY: '1',
  BLOCKS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/noop',
};

const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8', timeout: 30000, env });

describe('create-blocks-app (unscoped)', () => {
  it('prints the same --help as @aws-cdk-blocks/create-blocks-app', () => {
    const scoped = run(SCOPED_CLI, ['--help']);
    const unscoped = run(BIN, ['--help']);
    assert.strictEqual(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /--template/);
    assert.strictEqual(unscoped.status, 0, unscoped.stderr);
    assert.strictEqual(unscoped.stdout, scoped.stdout);
  });

  it('scaffolds an app from the template it is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'create-blocks-app-unscoped-'));
    try {
      const app = join(root, 'my-app');
      const result = run(BIN, [app, '--template', 'bare', '--skip-install', '-y']);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(existsSync(join(app, 'package.json')), 'package.json is scaffolded');
      assert.ok(readJson(join(app, '.cdk-blocks', 'config.json')).stackId, 'the app has a stackId');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("exits with the CLI's exit code when the CLI fails", () => {
    const root = mkdtempSync(join(tmpdir(), 'create-blocks-app-unscoped-'));
    try {
      const result = run(BIN, [join(root, 'my-app'), '--template', 'no-such-template', '--skip-install', '-y']);
      assert.strictEqual(result.status, 1);
      assert.match(result.stderr, /Unknown template "no-such-template"/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('passes SIGTERM on to the CLI and ends by the same signal', { skip: process.platform === 'win32' }, async () => {
    // In a directory that has a package.json the CLI asks before it changes anything,
    // so it is still running, and has changed nothing, when the signal arrives.
    const root = mkdtempSync(join(tmpdir(), 'create-blocks-app-unscoped-'));
    writeFileSync(join(root, 'package.json'), '{ "name": "existing-app", "version": "1.0.0" }\n');
    // Its own process group, so the cleanup below can end the wrapper and the CLI together.
    const child = spawn(process.execPath, [BIN], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, 15000, 'still running after 15 seconds');
    });
    try {
      // 'close' waits for the CLI too: it holds the output pipes until it exits.
      const ended = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
      let stdout = '';
      const prompted = new Promise((resolve) => {
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (stdout.includes('Proceed?')) resolve('prompted');
        });
      });
      assert.strictEqual(await Promise.race([prompted, ended, deadline]), 'prompted', `no prompt:\n${stdout}`);
      child.kill('SIGTERM');
      assert.deepStrictEqual(await Promise.race([ended, deadline]), { code: null, signal: 'SIGTERM' });
      assert.deepStrictEqual(readdirSync(root), ['package.json']);
    } finally {
      clearTimeout(timer);
      // If the signal was not passed on, the CLI is still at its prompt and would keep this test file running.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The process group has ended already.
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  // The wrapper has no code of its own to version: a release of one package must be a release of both.
  it('is released at the same version as the CLI it runs', () => {
    const wrapper = readJson(join(here, 'package.json'));
    const scoped = readJson(join(SCOPED_DIR, 'package.json'));
    assert.strictEqual(scoped.name, SCOPED_NAME);
    assert.strictEqual(wrapper.version, scoped.version);
    assert.strictEqual(wrapper.dependencies[SCOPED_NAME], scoped.version, 'the dependency is an exact pin');

    const { fixed } = readJson(join(here, '../../.changeset/config.json'));
    const group = fixed.find((names) => names.includes(wrapper.name));
    assert.ok(group?.includes(SCOPED_NAME), 'both packages are in one changesets "fixed" group');
  });
});
