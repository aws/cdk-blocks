// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The forwarded-headers rewrite, run for real: the SSR cache guard module (which
 * carries it) is written to a temp directory and imported, so the tests run the
 * exact source the construct writes into the server bundle. Importing a module
 * with a trust patches `http.Server#emit` in this process.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import {
  CLOUDFRONT_FORWARDED_TRUST,
  DIRECT_FORWARDED_TRUST,
  type ForwardedHeadersTrust,
  STACKED_FORWARDED_TRUST,
  VIEWER_IP_HEADER,
  VIEWER_IP_JS,
  forwardedHeadersTrustFor,
  withoutForwardedClientAddress,
} from './forwarded_headers.js';
import {
  SSR_CACHE_GUARD_FILE,
  SSR_CACHE_GUARD_HANDLER_FILE,
  generateSsrCacheGuardHandlerCode,
  generateSsrCacheGuardModule,
} from './ssr_cache_guard.js';

type Lookup = (name: string) => string | string[] | undefined;
type Values = Record<string, string | null>;
type HeaderMap = Record<string, string>;
type MultiHeaderMap = Record<string, string[]>;
type LambdaEvent = {
  headers?: HeaderMap;
  multiValueHeaders?: MultiHeaderMap;
  requestContext?: { identity?: { sourceIp: string }; http?: { sourceIp: string }; elb?: object };
};
type Peer = { sourceIp?: string; socket?: string };
type ForwardedModule = {
  forwardedValues: (get: Lookup, peer?: Peer) => Values | null;
  normalizeForwardedEvent: (event: LambdaEvent) => LambdaEvent;
};
type HandlerModule = { handler: (event: LambdaEvent) => Promise<unknown> };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forwarded-headers-'));
let counter = 0;
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const load = async <T>(
  forwarded: ForwardedHeadersTrust | undefined,
  extra: Record<string, string> = {},
  entry = SSR_CACHE_GUARD_FILE,
): Promise<T> => {
  const dir = path.join(tmpRoot, `m${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SSR_CACHE_GUARD_FILE), generateSsrCacheGuardModule({ forwarded }));
  for (const [name, code] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), code);
  return (await import(pathToFileURL(path.join(dir, entry)).href)) as T;
};

const lookup =
  (headers: Record<string, string>): Lookup =>
  (name) =>
    headers[name];

void describe('forwardedHeadersTrustFor', () => {
  void it('trusts what each built-in door sets, and nothing behind a bring-your-own door or none', () => {
    assert.deepEqual(forwardedHeadersTrustFor(undefined), CLOUDFRONT_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('cloudfront'), CLOUDFRONT_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('stackedRouter'), STACKED_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('alb'), DIRECT_FORWARDED_TRUST);
    assert.deepEqual(forwardedHeadersTrustFor('apiGateway'), DIRECT_FORWARDED_TRUST);
    assert.equal(forwardedHeadersTrustFor('custom'), undefined);
    assert.equal(forwardedHeadersTrustFor('none'), undefined);
  });
});

void describe('forwardedValues', () => {
  void it('behind CloudFront: the router-set host and viewer address; X-Forwarded-For is never read', async () => {
    const m = await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    const values = m.forwardedValues(
      lookup({
        host: 'abc123.execute-api.us-west-2.amazonaws.com',
        'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
        [VIEWER_IP_HEADER]: '203.0.113.10',
        // Whatever the origin delivers, only the router's header names the client.
        'x-forwarded-for': '6.6.6.6, 7.7.7.7',
        'x-forwarded-proto': 'http',
      }),
      { sourceIp: '64.252.88.29' },
    );
    assert.deepEqual(values, {
      host: 'd111111abcdef8.cloudfront.net',
      'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
      [VIEWER_IP_HEADER]: null,
      'x-forwarded-for': '203.0.113.10',
      'x-forwarded-proto': 'https',
    });
  });

  void it('behind CloudFront without the router header: the address the server saw, never a client-sent entry', async () => {
    const m = await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    const headers = { 'x-forwarded-for': '192.0.2.1' };
    assert.equal(m.forwardedValues(lookup(headers), { sourceIp: '64.252.88.29' })?.['x-forwarded-for'], '64.252.88.29');
    assert.equal(m.forwardedValues(lookup(headers), { socket: '127.0.0.1' })?.['x-forwarded-for'], '127.0.0.1');
    assert.equal(m.forwardedValues(lookup(headers))?.['x-forwarded-for'], null);
  });

  void it('takes only an address from the door header', async () => {
    const m = await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    for (const bad of ['not-an-address', '203.0.113.10:443x', '<script>']) {
      assert.equal(m.forwardedValues(lookup({ [VIEWER_IP_HEADER]: bad }))?.['x-forwarded-for'], null, bad);
    }
    assert.equal(m.forwardedValues(lookup({ [VIEWER_IP_HEADER]: '2001:db8::1' }))?.['x-forwarded-for'], '2001:db8::1');
  });

  void it('behind the stacked door: the edge-set viewer address and https, not the plain-HTTP hop', async () => {
    const m = await load<ForwardedModule>(STACKED_FORWARDED_TRUST);
    const values = m.forwardedValues(
      lookup({
        host: 'internal-router-123.us-west-2.elb.amazonaws.com',
        'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
        [VIEWER_IP_HEADER]: '203.0.113.10',
        'x-forwarded-for': '6.6.6.6, 203.0.113.10, 130.176.74.249',
        'x-forwarded-proto': 'http',
      }),
    );
    assert.deepEqual(values, {
      host: 'd111111abcdef8.cloudfront.net',
      'x-forwarded-host': 'd111111abcdef8.cloudfront.net',
      [VIEWER_IP_HEADER]: null,
      'x-forwarded-for': '203.0.113.10',
      'x-forwarded-proto': 'https',
    });
  });

  void it('behind API Gateway: sourceIp, even when X-Forwarded-For has no appended entry', async () => {
    const m = await load<ForwardedModule>(DIRECT_FORWARDED_TRUST);
    const values = m.forwardedValues(lookup({ host: 'app.example.com', 'x-forwarded-for': '203.0.113.9' }), {
      sourceIp: '198.51.100.1',
    });
    assert.equal(values?.['x-forwarded-for'], '198.51.100.1');
    assert.equal(values?.['x-forwarded-proto'], undefined, 'the scheme API Gateway set is kept');
  });

  void it('behind the ALB (no sourceIp): Host, and the right-most entry; a client x-forwarded-host is dropped', async () => {
    const m = await load<ForwardedModule>(DIRECT_FORWARDED_TRUST);
    assert.deepEqual(
      m.forwardedValues(
        lookup({
          host: 'app.example.com',
          'x-forwarded-host': 'evil.example',
          [VIEWER_IP_HEADER]: '6.6.6.6',
          'x-forwarded-for': '6.6.6.6, 198.51.100.7',
        }),
      ),
      { host: 'app.example.com', 'x-forwarded-host': 'app.example.com', [VIEWER_IP_HEADER]: null, 'x-forwarded-for': '198.51.100.7' },
    );
    assert.deepEqual(m.forwardedValues(lookup({ 'x-forwarded-host': 'evil.example' })), {
      'x-forwarded-host': null,
      [VIEWER_IP_HEADER]: null,
      'x-forwarded-for': null,
    });
    assert.equal(
      m.forwardedValues(lookup({ 'x-forwarded-for': '6.6.6.6, 2001:db8::7' }))?.['x-forwarded-for'],
      '2001:db8::7',
    );
  });

  void it('rewrites nothing without a trust (a bring-your-own door, none)', async () => {
    const m = await load<ForwardedModule>(undefined);
    assert.equal(m.forwardedValues(lookup({ host: 'a', 'x-forwarded-for': '1.1.1.1' })), null);
    const event = { headers: { Host: 'a', 'X-Forwarded-For': '6.6.6.6, 1.1.1.1' } };
    assert.deepEqual(m.normalizeForwardedEvent(structuredClone(event)), event);
  });
});

void describe('VIEWER_IP_JS', () => {
  const run = (event: { request: { headers: Record<string, { value: string }> }; viewer?: { ip: string } }) => {
    new Function('event', 'request', VIEWER_IP_JS)(event, event.request);
    return event.request.headers[VIEWER_IP_HEADER]?.value;
  };
  void it('sets the viewer address over a client-sent value, and removes a client value without one', () => {
    assert.equal(run({ request: { headers: { [VIEWER_IP_HEADER]: { value: '6.6.6.6' } } }, viewer: { ip: '203.0.113.10' } }), '203.0.113.10');
    assert.equal(run({ request: { headers: { [VIEWER_IP_HEADER]: { value: '6.6.6.6' } } } }), undefined);
  });
});

void describe('withoutForwardedClientAddress', () => {
  void it('drops the adapter’s ADDRESS_HEADER/XFF_DEPTH, and only those exact values', () => {
    const env = { ADDRESS_HEADER: 'x-forwarded-for', XFF_DEPTH: '1', ORIGIN: 'https://app.example.com' };
    assert.deepEqual(withoutForwardedClientAddress({ environment: env }).environment, { ORIGIN: 'https://app.example.com' });
    const own = { environment: { ADDRESS_HEADER: 'true-client-ip', XFF_DEPTH: '1' } };
    assert.equal(withoutForwardedClientAddress(own), own);
    const none = {};
    assert.equal(withoutForwardedClientAddress(none), none);
  });
});

void describe('normalizeForwardedEvent', () => {
  void it('rewrites a REST event, keeping each header’s spelling, and sets its source IP behind CloudFront', async () => {
    const m = await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    const event = m.normalizeForwardedEvent({
      headers: {
        Host: 'abc123.execute-api.us-west-2.amazonaws.com',
        'X-Forwarded-Host': 'd111111abcdef8.cloudfront.net',
        'X-Blocks-Viewer-Ip': '203.0.113.10',
        'X-Forwarded-For': '6.6.6.6, 203.0.113.10, 64.252.88.29',
        'X-Forwarded-Proto': 'https',
      },
      multiValueHeaders: {
        Host: ['abc123.execute-api.us-west-2.amazonaws.com'],
        'X-Forwarded-Host': ['d111111abcdef8.cloudfront.net'],
        'X-Blocks-Viewer-Ip': ['203.0.113.10'],
        'X-Forwarded-For': ['6.6.6.6, 203.0.113.10, 64.252.88.29'],
      },
      requestContext: { identity: { sourceIp: '64.252.88.29' } },
    });
    assert.deepEqual(event.headers, {
      Host: 'd111111abcdef8.cloudfront.net',
      'X-Forwarded-Host': 'd111111abcdef8.cloudfront.net',
      'X-Forwarded-For': '203.0.113.10',
      'X-Forwarded-Proto': 'https',
    });
    assert.deepEqual(event.multiValueHeaders, {
      Host: ['d111111abcdef8.cloudfront.net'],
      'X-Forwarded-Host': ['d111111abcdef8.cloudfront.net'],
      'X-Forwarded-For': ['203.0.113.10'],
      'x-forwarded-proto': ['https'],
    });
    assert.equal(event.requestContext?.identity?.sourceIp, '203.0.113.10');
  });

  void it('keeps an HTTP API event’s sourceIp, and writes X-Forwarded-For from it', async () => {
    const m = await load<ForwardedModule>(DIRECT_FORWARDED_TRUST);
    const event = m.normalizeForwardedEvent({
      // An X-Forwarded-For with no entry appended by API Gateway: only the client's.
      headers: { host: 'abc123.execute-api.us-west-2.amazonaws.com', 'x-forwarded-for': '203.0.113.9' },
      requestContext: { http: { sourceIp: '198.51.100.1' } },
    });
    assert.equal(event.headers?.['x-forwarded-for'], '198.51.100.1');
    assert.equal(event.requestContext?.http?.sourceIp, '198.51.100.1');
  });

  void it('keeps a REST event’s sourceIp behind API Gateway, whatever the client sends', async () => {
    const m = await load<ForwardedModule>(DIRECT_FORWARDED_TRUST);
    const event = m.normalizeForwardedEvent({
      headers: { Host: 'api.example.com', 'X-Forwarded-For': '203.0.113.9', 'X-Blocks-Viewer-Ip': '203.0.113.9' },
      requestContext: { identity: { sourceIp: '198.51.100.1' } },
    });
    assert.deepEqual(event.headers, { Host: 'api.example.com', 'X-Forwarded-For': '198.51.100.1', 'x-forwarded-host': 'api.example.com' });
    assert.equal(event.requestContext?.identity?.sourceIp, '198.51.100.1');
  });

  void it('runs in the handler wrapper before the handler', async () => {
    const inner = `export const handler = async (event) => ({ statusCode: 200, body: JSON.stringify(event.headers) });\n`;
    const m = await load<HandlerModule>(
      CLOUDFRONT_FORWARDED_TRUST,
      { 'inner.mjs': inner, [SSR_CACHE_GUARD_HANDLER_FILE]: generateSsrCacheGuardHandlerCode('./inner.mjs') },
      SSR_CACHE_GUARD_HANDLER_FILE,
    );
    const result = (await m.handler({
      headers: {
        host: 'origin.example',
        'x-forwarded-host': 'app.example.com',
        [VIEWER_IP_HEADER]: '203.0.113.10',
        'x-forwarded-for': '6.6.6.6, 203.0.113.10, 64.252.88.29',
      },
    })) as { body: string };
    assert.deepEqual(JSON.parse(result.body), {
      host: 'app.example.com',
      'x-forwarded-host': 'app.example.com',
      'x-forwarded-for': '203.0.113.10',
      'x-forwarded-proto': 'https',
    });
  });
});

type Seen = { headers: http.IncomingHttpHeaders; raw: string[]; distinct?: NodeJS.Dict<string[]> };

/** Send one request (headers as raw lines) to a server in this process, and return what its listener saw. */
const serve = async (lines: [string, string][], readDistinct = true): Promise<Seen> => {
  let seen: Seen | undefined;
  let failure: unknown;
  const server = http.createServer((req, res) => {
    try {
      // headersDistinct is computed lazily, so read it after the rewrite ran.
      seen = { headers: req.headers, raw: req.rawHeaders, distinct: readDistinct ? req.headersDistinct : undefined };
    } catch (e) {
      failure = e;
    }
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    // A raw request, so each header line goes out exactly as listed.
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        const head = lines.map(([name, value]) => `${name}: ${value}\r\n`).join('');
        socket.write(`GET /dynamic HTTP/1.1\r\n${head}connection: close\r\n\r\n`);
      });
      socket.on('data', () => {});
      socket.on('end', resolve);
      socket.on('error', reject);
    });
  } finally {
    server.close();
  }
  if (failure) throw failure;
  assert.ok(seen, 'the listener ran');
  return seen;
};

const forwardedPairs = (raw: string[]): [string, string][] => {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]).toLowerCase(), String(raw[i + 1])]);
  return pairs.filter(([k]) => ['host', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', VIEWER_IP_HEADER].includes(k));
};

void describe('Node HTTP server', () => {
  void it('sees the rewritten headers, raw headers and headersDistinct, with duplicate X-Forwarded-For lines', async () => {
    await load<ForwardedModule>(STACKED_FORWARDED_TRUST);
    const seen = await serve([
      ['host', 'internal-router-123.us-west-2.elb.amazonaws.com'],
      ['x-forwarded-host', 'd111111abcdef8.cloudfront.net'],
      [VIEWER_IP_HEADER, '203.0.113.10'],
      ['x-forwarded-for', '6.6.6.6'],
      ['x-forwarded-for', '203.0.113.10, 130.176.74.249'],
      ['x-forwarded-proto', 'http'],
    ]);
    assert.equal(seen.headers.host, 'd111111abcdef8.cloudfront.net');
    assert.equal(seen.headers['x-forwarded-host'], 'd111111abcdef8.cloudfront.net');
    assert.equal(seen.headers['x-forwarded-for'], '203.0.113.10');
    assert.equal(seen.headers['x-forwarded-proto'], 'https');
    assert.equal(seen.headers[VIEWER_IP_HEADER], undefined);
    assert.deepEqual(forwardedPairs(seen.raw), [
      ['host', 'd111111abcdef8.cloudfront.net'],
      ['x-forwarded-host', 'd111111abcdef8.cloudfront.net'],
      ['x-forwarded-for', '203.0.113.10'],
      ['x-forwarded-proto', 'https'],
    ]);
    assert.deepEqual(seen.distinct?.['x-forwarded-for'], ['203.0.113.10']);
    assert.deepEqual(seen.distinct?.host, ['d111111abcdef8.cloudfront.net']);
    assert.deepEqual(seen.distinct?.['x-forwarded-proto'], ['https']);
    assert.equal(seen.distinct?.[VIEWER_IP_HEADER], undefined);
  });

  void it('keeps a header whose name is an Object.prototype key in headers and rawHeaders', async () => {
    await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    // Not reading headersDistinct: some Node.js versions throw on this name there themselves.
    const seen = await serve(
      [
        ['host', 'origin.example'],
        [VIEWER_IP_HEADER, '203.0.113.10'],
        ['constructor', 'keepme'],
      ],
      false,
    );
    assert.equal(seen.headers['x-forwarded-for'], '203.0.113.10');
    assert.equal(seen.headers.constructor, 'keepme');
    const pairs: string[] = [];
    for (let i = 0; i + 1 < seen.raw.length; i += 2) pairs.push(`${String(seen.raw[i]).toLowerCase()}=${seen.raw[i + 1]}`);
    assert.ok(pairs.includes('constructor=keepme'), pairs.join(' '));
  });

  void it('behind API Gateway: the Lambda Web Adapter’s sourceIp, and an added x-forwarded-host in headersDistinct', async () => {
    await load<ForwardedModule>(DIRECT_FORWARDED_TRUST);
    const seen = await serve([
      ['host', 'api.example.com'],
      ['x-forwarded-for', '203.0.113.9'],
      ['x-amzn-request-context', JSON.stringify({ http: { sourceIp: '198.51.100.1' } })],
    ]);
    assert.equal(seen.headers['x-forwarded-for'], '198.51.100.1');
    assert.deepEqual(seen.distinct?.['x-forwarded-for'], ['198.51.100.1']);
    assert.equal(seen.headers['x-forwarded-host'], 'api.example.com');
    assert.deepEqual(seen.distinct?.['x-forwarded-host'], ['api.example.com']);
  });

  void it('without X-Forwarded-For (a readiness check): the socket’s address, so ADDRESS_HEADER finds one', async () => {
    await load<ForwardedModule>(CLOUDFRONT_FORWARDED_TRUST);
    const seen = await serve([['host', '127.0.0.1:8080']]);
    assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1');
    assert.deepEqual(seen.distinct?.['x-forwarded-for'], ['127.0.0.1']);
  });
});
