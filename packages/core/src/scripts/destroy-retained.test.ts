// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { findStackId, retainedByDestroy, retainedResourcesNote } from './destroy.js';
import { runDestroyWithRetries } from './sandbox.js';

type Command = { constructor: { name: string }; input: { StackName?: string; NextToken?: string } };

/** A CloudFormation client whose events come in `pages`, as DescribeStackEvents returns them. */
function fakeCfn(pages: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ name: string; input: Command['input'] }> = [];
  return {
    calls,
    async send(command: unknown) {
      const { constructor: type, input } = command as Command;
      calls.push({ name: type.name, input });
      if (type.name === 'DescribeStacksCommand') return { Stacks: [{ StackId: 'arn:aws:cloudformation:us-east-1:1:stack/app-prod/abc' }] };
      const index = Number(input.NextToken ?? 0);
      return { StackEvents: pages[index] ?? [], NextToken: index + 1 < pages.length ? String(index + 1) : undefined };
    },
  };
}

const table = { ResourceType: 'AWS::DynamoDB::Table', LogicalResourceId: 'todos1A2B', PhysicalResourceId: 'app-prod-todos', ResourceStatus: 'DELETE_SKIPPED' };
const bucket = { ResourceType: 'AWS::S3::Bucket', LogicalResourceId: 'logs3C4D', PhysicalResourceId: 'app-prod-logs', ResourceStatus: 'DELETE_SKIPPED' };
const deleted = { ResourceType: 'AWS::Lambda::Function', LogicalResourceId: 'fn', PhysicalResourceId: 'app-prod-fn', ResourceStatus: 'DELETE_COMPLETE' };
const stackEvent = { ResourceType: 'AWS::CloudFormation::Stack', LogicalResourceId: 'app-prod', ResourceStatus: 'DELETE_COMPLETE' };

describe('retained resources after a destroy', () => {
  it('reads the stack id before the delete and asks for events by that id', async () => {
    const cfn = fakeCfn([[table]]);
    const stackId = await findStackId(cfn, 'app-prod');
    assert.strictEqual(stackId, 'arn:aws:cloudformation:us-east-1:1:stack/app-prod/abc');
    await retainedByDestroy(cfn, stackId as string);
    assert.strictEqual(cfn.calls[1].input.StackName, stackId);
  });

  it('lists each DELETE_SKIPPED resource once, across pages, and nothing else', async () => {
    const cfn = fakeCfn([[stackEvent, deleted, table], [bucket, { ...table, ResourceStatus: 'DELETE_SKIPPED' }]]);
    const found = await retainedByDestroy(cfn, 'arn');
    assert.deepStrictEqual(found.map((r) => r.physicalId), ['app-prod-todos', 'app-prod-logs']);
  });

  it('says nothing when no resource was kept', async () => {
    const found = await retainedByDestroy(fakeCfn([[stackEvent, deleted]]), 'arn');
    assert.strictEqual(retainedResourcesNote(found), undefined);
  });

  it('names each kept resource and how to remove a table and a bucket', () => {
    const note = retainedResourcesNote([
      { type: 'AWS::DynamoDB::Table', logicalId: 'todos1A2B', physicalId: 'app-prod-todos' },
      { type: 'AWS::S3::Bucket', logicalId: 'logs3C4D', physicalId: 'app-prod-logs' },
    ]) as string;
    assert.match(note, /2 resources were kept/);
    assert.match(note, /AWS::DynamoDB::Table {2}app-prod-todos/);
    assert.match(note, /AWS::S3::Bucket {2}app-prod-logs/);
    assert.match(note, /--no-deletion-protection-enabled/);
    assert.match(note, /aws s3 rb/);
  });

  it('falls back to the logical id when the physical id is unknown', () => {
    assert.match(retainedResourcesNote([{ type: 'AWS::Foo::Bar', logicalId: 'Foo1' }]) as string, /AWS::Foo::Bar {2}Foo1/);
  });
});

describe('runDestroyWithRetries afterDestroy', () => {
  async function run(afterDestroy: () => Promise<void>, runDestroy: () => void = () => {}) {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    let error: unknown;
    try {
      await runDestroyWithRetries({
        runDestroy,
        listStacks: () => [],
        emptyBuckets: async () => {},
        sleep: async () => {},
        retryDelays: [],
        afterDestroy,
      });
    } catch (e) {
      error = e;
    } finally {
      console.log = orig;
    }
    return { logs, error };
  }

  it('runs once after the success line', async () => {
    let calls = 0;
    const { logs } = await run(async () => { calls++; console.log('after'); });
    assert.strictEqual(calls, 1);
    assert.ok(logs.findIndex((l) => l.includes('destroyed!')) < logs.indexOf('after'), logs.join('\n'));
  });

  it('does not fail a destroy that already succeeded when it throws', async () => {
    const { error } = await run(async () => { throw new Error('AccessDenied'); });
    assert.strictEqual(error, undefined);
  });

  it('does not run when the destroy fails', async () => {
    let calls = 0;
    const { error } = await run(async () => { calls++; }, () => { throw new Error('boom'); });
    assert.ok(error);
    assert.strictEqual(calls, 0);
  });
});
