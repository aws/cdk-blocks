// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Forwarded headers the server can trust: the public host, the scheme and the
 * client address, as the door in front of the server set them.
 *
 * Behind a front door the server's own view of a request is an internal one:
 * `Host` names the origin (the REST API, the Web Function endpoint, the
 * router's ALB), the socket's peer is a proxy, and `X-Forwarded-For` starts
 * with whatever the client sent. Each built-in door sets or appends some of
 * these headers itself, so Hosting knows which values come from the door:
 *
 * | Door | Public host | Client address | Scheme |
 * |---|---|---|---|
 * | CloudFront (REST API or Web Function origin) | `x-forwarded-host` (the router sets it from the viewer's `Host`, over any client value) | `x-blocks-viewer-ip` (the router sets it from the viewer's address, over any client value) | `https` (every server behavior redirects HTTP to HTTPS) |
 * | Stacked (CloudFront edge over the ALB router) | `x-forwarded-host` (the edge sets it) | `x-blocks-viewer-ip` (the edge sets it) | `https` (as above; the edge → router hop may be plain HTTP) |
 * | ALB | `Host` | right-most `X-Forwarded-For` entry (the ALB appends its peer) | `x-forwarded-proto` (the ALB sets it from its listener) |
 * | API Gateway (HTTP or REST) | `Host` (the API's domain or the custom domain) | the event's `sourceIp` (API Gateway's TCP peer; on a Lambda Web Adapter server, from the `x-amzn-request-context` header the adapter sets) | `x-forwarded-proto` (set by API Gateway) |
 *
 * No value is counted from the left of `X-Forwarded-For`, and behind the
 * CloudFront doors `X-Forwarded-For` isn't read at all: what the client sends
 * there, or in `x-blocks-viewer-ip`, never becomes the client address. Each
 * origin admits only its door (the REST API checks the origin-verify header,
 * the Web Function endpoint signs with origin access control, the stacked
 * router checks the edge's header). When the door's value is missing (a
 * request that didn't come through the door's function, such as the Lambda
 * Web Adapter's readiness check), `X-Forwarded-For` is the address the server
 * itself saw (the socket peer, or the event's `sourceIp`), so a framework that
 * requires the header still gets one.
 *
 * Before the server sees a request, Hosting rewrites it from those values:
 * `Host` and `x-forwarded-host` both name the public host, `X-Forwarded-For`
 * holds only the client address, and `x-forwarded-proto` the viewer's scheme;
 * behind the CloudFront doors, a Lambda event's
 * `requestContext.identity.sourceIp` / `requestContext.http.sourceIp` are the
 * client address too (behind the direct doors they already are), and the
 * `x-blocks-viewer-ip` header is removed. A framework
 * then reads the right values whichever header it trusts (SvelteKit's
 * `HOST_HEADER`/`ADDRESS_HEADER` with `XFF_DEPTH=1`, Nitro's `Host` and
 * `getRequestIP(event, { xForwardedFor: true })`, Astro once
 * `security.allowedDomains` names the host).
 *
 * The rewrite ships in the SSR cache guard module (`ssr_cache_guard.ts`), which
 * is already loaded in front of every server shape: a Node HTTP server (it
 * patches `http.Server#emit` for `request` events) and a native Lambda handler
 * (the handler wrapper rewrites the event). A bring-your-own door, and
 * `frontDoor: 'none'`, get no rewrite: what reaches the server there is the
 * door author's to define.
 *
 * @module
 * @internal Framework-only.
 */

/**
 * The header the CloudFront doors' viewer-request functions set to the
 * viewer's address (`event.viewer.ip`), over any value the client sent.
 */
export const VIEWER_IP_HEADER = 'x-blocks-viewer-ip';

/**
 * CloudFront Functions source (JS 2.0) that sets {@link VIEWER_IP_HEADER} on
 * `request` from `event.viewer.ip`, and removes a client-sent one when the
 * event has no viewer address.
 */
export const VIEWER_IP_JS = `if (event.viewer && event.viewer.ip) { request.headers['${VIEWER_IP_HEADER}'] = { value: event.viewer.ip }; } else { delete request.headers['${VIEWER_IP_HEADER}']; }`;

/** Which forwarded headers come from the door (see the module docs). */
export interface ForwardedHeadersTrust {
  /**
   * A header the door sets to the client address, over any client value.
   * When set, `X-Forwarded-For` and `sourceIp` are not read for the client.
   */
  readonly clientHeader?: string;
  /**
   * Without `clientHeader`: the `X-Forwarded-For` entry, counted from the
   * right (1 = right-most), that the door appended for the client. Used only
   * when the request carries no `sourceIp` (the event's, or the Lambda Web
   * Adapter's `x-amzn-request-context`), which is preferred.
   */
  readonly clientHop?: number;
  /** The header that carries the public host. */
  readonly hostHeader: 'x-forwarded-host' | 'host';
  /** The viewer's scheme, when the door admits only that one (it redirects HTTP to HTTPS). */
  readonly proto?: 'https';
}

/** The CloudFront door (and a Web Function, which is only reachable through it). */
export const CLOUDFRONT_FORWARDED_TRUST: ForwardedHeadersTrust = {
  clientHeader: VIEWER_IP_HEADER,
  hostHeader: 'x-forwarded-host',
  proto: 'https',
};
/** The stacked door: CloudFront edge over the ALB router. */
export const STACKED_FORWARDED_TRUST: ForwardedHeadersTrust = {
  clientHeader: VIEWER_IP_HEADER,
  hostHeader: 'x-forwarded-host',
  proto: 'https',
};
/** The ALB and API Gateway doors: the viewer talks to the origin directly. */
export const DIRECT_FORWARDED_TRUST: ForwardedHeadersTrust = { clientHop: 1, hostHeader: 'host' };

/**
 * The forwarded-headers trust of a built-in door, or undefined for a
 * bring-your-own door and `'none'`.
 *
 * @param kind the door kind (`undefined` or `'cloudfront'` for the default door).
 * @returns the trust, or undefined to leave requests as they arrive.
 */
export const forwardedHeadersTrustFor = (kind: string | undefined): ForwardedHeadersTrust | undefined => {
  switch (kind) {
    case undefined:
    case 'cloudfront':
      return CLOUDFRONT_FORWARDED_TRUST;
    case 'stackedRouter':
      return STACKED_FORWARDED_TRUST;
    case 'alb':
    case 'apiGateway':
      return DIRECT_FORWARDED_TRUST;
    default:
      return undefined;
  }
};

/**
 * The runtime code (ES module source, no imports beyond `node:http`, which
 * the including module imports as `http`) that rewrites forwarded headers:
 * exports `forwardedValues`, `normalizeForwardedEvent` and
 * `normalizeForwardedNodeRequest`, and patches `http.Server#emit` when
 * evaluated. With no trust, the exports leave every request as it is.
 *
 * @param trust the door's trust, or undefined.
 * @returns the source, to be embedded in a module that imports `node:http` as `http`.
 */
export const generateForwardedHeadersCode = (trust: ForwardedHeadersTrust | undefined): string => `
// ---- Forwarded headers: the public host, scheme and client address the door set ----
const FORWARDED = ${JSON.stringify(trust ?? null)};
const FORWARDED_INSTALLED = Symbol.for('aws-blocks.hosting.forwarded-headers');
const FORWARDED_VIEWER_IP = ${JSON.stringify(VIEWER_IP_HEADER)};
const FORWARDED_NAMES = ['host', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', FORWARDED_VIEWER_IP];

function firstValue(value) {
  if (value == null) return undefined;
  const text = String([].concat(value)[0]).split(',')[0].trim();
  return text === '' ? undefined : text;
}

// An IPv4 or IPv6 address (no port, no list), or undefined.
function addressValue(value) {
  const text = firstValue(value);
  return text !== undefined && text.length <= 45 && /^[0-9a-fA-F:.]+$/.test(text) ? text : undefined;
}

/**
 * The values to set, from a header lookup (lower-case name -> value or
 * undefined) and what the server itself saw (peer.sourceIp: the event's or
 * the Lambda Web Adapter's sourceIp; peer.socket: the socket's peer):
 * { host?, 'x-forwarded-host'?, 'x-forwarded-for'?, 'x-forwarded-proto'?, 'x-blocks-viewer-ip'? },
 * where null removes the header and a missing key leaves it. Null when there
 * is nothing to rewrite.
 */
export function forwardedValues(get, peer) {
  if (!FORWARDED) return null;
  const out = {};
  const host = firstValue(get(FORWARDED.hostHeader));
  if (host !== undefined) {
    out.host = host;
    out['x-forwarded-host'] = host;
  } else if (FORWARDED.hostHeader === 'host') {
    // A client-sent x-forwarded-host never reaches the server.
    out['x-forwarded-host'] = null;
  }
  // The door's own header never reaches the server (nor a client-sent one).
  out[FORWARDED_VIEWER_IP] = null;
  const seen = peer && addressValue(peer.sourceIp);
  let client;
  if (FORWARDED.clientHeader) {
    // Set by the door's viewer-request function, over any client value;
    // X-Forwarded-For is never read.
    client = addressValue(get(FORWARDED.clientHeader));
  } else if (seen !== undefined) {
    // The origin's TCP peer (API Gateway's sourceIp).
    client = seen;
  } else {
    // The door appended the client FORWARDED.clientHop entries from the
    // right; anything to its left came from the client. With fewer entries,
    // the left-most one was still appended by the door's own hop.
    const raw = get('x-forwarded-for');
    const entries = raw == null ? [] : [].concat(raw).join(',').split(',').map((e) => e.trim()).filter((e) => e !== '');
    if (entries.length > 0) client = addressValue(entries[Math.max(0, entries.length - FORWARDED.clientHop)]);
  }
  // Without the door's value, the address the server saw (never a client-sent one).
  const address = client ?? seen ?? (peer && addressValue(peer.socket));
  out['x-forwarded-for'] = address ?? null;
  if (FORWARDED.proto) out['x-forwarded-proto'] = FORWARDED.proto;
  return out;
}

function eventLookup(event) {
  return (name) => {
    for (const map of [event.multiValueHeaders, event.headers]) {
      if (!map) continue;
      for (const key of Object.keys(map)) {
        if (key.toLowerCase() === name && map[key] != null) return map[key];
      }
    }
    return undefined;
  };
}

// Set (or with null, remove) a header, keeping the spelling of the first key
// the event already has for it (REST v1 and ALB events keep the client's case).
function setEventHeader(map, name, value, multi) {
  if (!map) return;
  let spelling;
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() !== name) continue;
    if (spelling === undefined) spelling = key;
    delete map[key];
  }
  if (value !== null) map[spelling ?? name] = multi ? [value] : value;
}

function eventSourceIp(context) {
  if (!context || typeof context !== 'object') return undefined;
  if (context.identity && typeof context.identity === 'object' && context.identity.sourceIp) return context.identity.sourceIp;
  if (context.http && typeof context.http === 'object' && context.http.sourceIp) return context.http.sourceIp;
  return undefined;
}

/** Rewrite a Lambda event's forwarded headers (and source IP) in place. */
export function normalizeForwardedEvent(event) {
  if (!event || typeof event !== 'object' || (!event.headers && !event.multiValueHeaders)) return event;
  const get = eventLookup(event);
  const context = event.requestContext;
  const values = forwardedValues(get, { sourceIp: eventSourceIp(context) });
  if (!values) return event;
  // Behind a door that names the client in its own header, sourceIp is the
  // door's address: set it to the client's.
  const viewer = FORWARDED.clientHeader ? addressValue(get(FORWARDED.clientHeader)) : undefined;
  for (const name of FORWARDED_NAMES) {
    if (!Object.hasOwn(values, name)) continue;
    setEventHeader(event.headers, name, values[name], false);
    setEventHeader(event.multiValueHeaders, name, values[name], true);
  }
  if (viewer && context && typeof context === 'object') {
    if (context.identity && typeof context.identity === 'object' && 'sourceIp' in context.identity) context.identity.sourceIp = viewer;
    if (context.http && typeof context.http === 'object' && 'sourceIp' in context.http) context.http.sourceIp = viewer;
  }
  return event;
}

// The sourceIp in the Lambda Web Adapter's x-amzn-request-context header (the
// adapter sets it on every request, over any client value).
function adapterSourceIp(headers) {
  const value = headers['x-amzn-request-context'];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string') return undefined;
  try {
    return eventSourceIp(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Rewrite a Node.js request's forwarded headers in place: headers,
 * rawHeaders, and headersDistinct (which Node computes lazily from the
 * original rawHeaders, so it is read, and cached, before rawHeaders changes).
 */
export function normalizeForwardedNodeRequest(req) {
  const headers = req.headers;
  const values = forwardedValues((name) => headers[name], {
    sourceIp: FORWARDED && !FORWARDED.clientHeader ? adapterSourceIp(headers) : undefined,
    socket: req.socket ? req.socket.remoteAddress : undefined,
  });
  if (!values) return req;
  let distinct = null;
  try {
    distinct = 'headersDistinct' in req ? req.headersDistinct : null;
  } catch {
    // Some Node.js versions throw here on a 'constructor' header; the rest still applies.
  }
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : null;
  const rawOut = [];
  if (raw) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (!Object.hasOwn(values, String(raw[i]).toLowerCase())) rawOut.push(raw[i], raw[i + 1]);
    }
  }
  for (const name of FORWARDED_NAMES) {
    if (!Object.hasOwn(values, name)) continue;
    if (values[name] === null) {
      delete headers[name];
      if (distinct) delete distinct[name];
    } else {
      headers[name] = values[name];
      if (distinct) distinct[name] = [values[name]];
      rawOut.push(name, values[name]);
    }
  }
  if (raw) raw.splice(0, raw.length, ...rawOut);
  return req;
}

function installForwardedHeaders() {
  if (!FORWARDED) return;
  // One install per process; the last module evaluated decides the trust.
  globalThis[FORWARDED_INSTALLED] = normalizeForwardedNodeRequest;
  const proto = http.Server.prototype;
  if (proto[FORWARDED_INSTALLED]) return;
  proto[FORWARDED_INSTALLED] = true;
  const emit = proto.emit;
  proto.emit = function (type, req, ...rest) {
    if (type === 'request' && req && req.headers) {
      try {
        globalThis[FORWARDED_INSTALLED](req);
      } catch {
        // Never fail a request because of the rewrite.
      }
    }
    return emit.call(this, type, req, ...rest);
  };
}

installForwardedHeaders();
`;

/**
 * The environment SvelteKit's adapter sets so `getClientAddress()` reads the
 * rewritten `X-Forwarded-For` (`ADDRESS_HEADER`, `XFF_DEPTH=1`).
 */
export const FORWARDED_CLIENT_ADDRESS_ENV: Readonly<Record<string, string>> = {
  ADDRESS_HEADER: 'x-forwarded-for',
  XFF_DEPTH: '1',
};

/**
 * The resource without {@link FORWARDED_CLIENT_ADDRESS_ENV}, for a server whose
 * requests are not rewritten (a bring-your-own door, `'none'`, or a server the
 * SSR cache guard can't be installed in front of). There `X-Forwarded-For` is
 * as the request arrived (its right-most entry is the nearest proxy's, and it
 * may be absent, which makes adapter-node's `getClientAddress()` throw), so
 * the server falls back to the socket's address, as without the rewrite.
 * Only the exact values the adapter sets are removed.
 *
 * @param resource the server compute resource.
 * @returns the resource, without those variables when it had them.
 */
export const withoutForwardedClientAddress = <R extends { readonly environment?: Record<string, string> }>(
  resource: R,
): R => {
  const env = resource.environment;
  if (!env || !Object.entries(FORWARDED_CLIENT_ADDRESS_ENV).every(([k, v]) => env[k] === v)) return resource;
  const rest = Object.fromEntries(Object.entries(env).filter(([k]) => !(k in FORWARDED_CLIENT_ADDRESS_ENV)));
  return { ...resource, environment: rest };
};
