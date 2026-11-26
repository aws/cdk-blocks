// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `signInVerified()`: a session for an identity the app verified itself, on a
 * `type: 'verified'` provider of a `store: 'builtin'` block.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AuthErrors } from './errors.js';
import { resolveOptions } from './resolve-options.js';
import { Browser, makeAuth, makeContext } from './test-helpers.js';

beforeEach(() => rmSync('.cdk-blocks/local/data', { recursive: true, force: true }));
afterEach(() => rmSync('.cdk-blocks/local/data', { recursive: true, force: true }));

const START = Date.UTC(2026, 0, 1);

describe('signInVerified', () => {
	test('opens a session whose identity is namespaced by the provider id', async () => {
		const h = makeAuth({
			store: 'builtin',
			users: { groups: ['admins'] },
			providers: { appleNative: { type: 'verified' } },
		});
		const b = new Browser();
		const signedIn = await b.request((ctx) =>
			h.auth.signInVerified(
				'appleNative',
				{ subject: '001234.abc', claims: { email: 'eve@example.com', name: 'Eve' }, groups: ['admins', 'x'] },
				ctx,
			),
		);
		assert.strictEqual(signedIn.userId, 'verified:appleNative:001234.abc');
		assert.strictEqual(signedIn.userSub, 'verified:appleNative:001234.abc');
		assert.strictEqual(signedIn.signInProvider, 'appleNative');
		assert.ok(b.jar.has(h.cookieName), 'the session cookie is set');

		const user = await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		assert.strictEqual(user.userId, signedIn.userId);
		assert.strictEqual(user.username, 'Eve');
		assert.strictEqual(user.attributes.email, 'eve@example.com');
		assert.deepStrictEqual(user.groups, ['admins']);
	});

	test('the caller cannot choose the issuer or the subject through claims', async () => {
		const h = makeAuth({ store: 'builtin', providers: { appleNative: { type: 'verified' } } });
		const b = new Browser();
		const user = await b.request((ctx) =>
			h.auth.signInVerified(
				'appleNative',
				{ subject: 'u-1', claims: { iss: 'https://okta.example.com', sub: 'someone-else' } },
				ctx,
			),
		);
		assert.strictEqual(user.userId, 'verified:appleNative:u-1');
		assert.strictEqual(user.claims?.iss, 'verified:appleNative');
		assert.strictEqual(user.claims?.sub, 'u-1');
	});

	test('validateUser sees the identity and can refuse it; nothing is stored', async () => {
		const seen: unknown[] = [];
		const h = makeAuth({
			store: 'builtin',
			providers: { appleNative: { type: 'verified' } },
			validateUser: async (candidate) => {
				seen.push({
					provider: candidate.provider,
					subject: candidate.subject,
					email: candidate.email,
					iss: candidate.claims.iss,
					sub: candidate.claims.sub,
				});
				throw new Error('not on the allowlist');
			},
		});
		const b = new Browser();
		await assert.rejects(
			b.request((ctx) =>
				h.auth.signInVerified(
					'appleNative',
					{ subject: 'u-1', claims: { email: 'eve@example.com', iss: 'https://okta.example.com', sub: 'x' } },
					ctx,
				),
			),
		);
		assert.deepStrictEqual(seen, [
			{
				provider: 'appleNative',
				subject: 'verified:appleNative:u-1',
				email: 'eve@example.com',
				iss: 'verified:appleNative',
				sub: 'u-1',
			},
		]);
		assert.strictEqual(b.jar.has(h.cookieName), false);
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
	});

	test('session.ttlSeconds is a fixed deadline from sign-in: use does not extend it', async (t) => {
		t.mock.timers.enable({ apis: ['Date'], now: START });
		const h = makeAuth({
			store: 'builtin',
			session: { ttlSeconds: 60 },
			providers: { appleNative: { type: 'verified' } },
		});
		const b = new Browser();
		await b.request((ctx) => h.auth.signInVerified('appleNative', { subject: 'u-1' }, ctx));

		t.mock.timers.setTime(START + 59_000);
		const user = await b.request((ctx) => h.auth.requireAuth(ctx));
		assert.strictEqual(user.userId, 'verified:appleNative:u-1');

		t.mock.timers.setTime(START + 61_000);
		await assert.rejects(
			b.request((ctx) => h.auth.requireAuth(ctx)),
			{ name: AuthErrors.NotAuthenticated },
		);
		assert.strictEqual(b.jar.has(h.cookieName), false, 'the cookie is cleared');
	});

	test('forceRefresh keeps a session that is still inside its deadline, and does not extend it', async (t) => {
		t.mock.timers.enable({ apis: ['Date'], now: START });
		const h = makeAuth({
			store: 'builtin',
			session: { ttlSeconds: 60 },
			providers: { appleNative: { type: 'verified' } },
		});
		const b = new Browser();
		await b.request((ctx) => h.auth.signInVerified('appleNative', { subject: 'u-1' }, ctx));

		t.mock.timers.setTime(START + 30_000);
		const session = await b.request((ctx) => h.auth.getAuthSession(ctx, { forceRefresh: true }));
		assert.strictEqual(session.userSub, 'verified:appleNative:u-1');
		assert.strictEqual((await b.request((ctx) => h.auth.requireAuth(ctx))).userId, 'verified:appleNative:u-1');

		t.mock.timers.setTime(START + 61_000);
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
	});

	test('forceRefresh still refreshes a redirect provider session on a block that also has a verified provider', async () => {
		const h = makeAuth({
			store: 'builtin',
			providers: {
				appleNative: { type: 'verified' },
				okta: { type: 'oidc', issuer: 'https://okta.example.com', clientId: 'c' },
			},
		});
		const okta = h.federation.get('okta');
		assert.ok(okta);
		okta.identity = {
			kind: 'direct',
			issuer: 'https://okta.example.com',
			subject: 'u-1',
			claims: { sub: 'u-1', iss: 'https://okta.example.com' },
			groups: [],
			expiresAt: Date.now() + 3600_000,
		};
		const b = new Browser();
		await b.request((ctx) => h.auth.completeFederated(ctx, 'okta'));
		await b.request((ctx) => h.auth.getAuthSession(ctx, { forceRefresh: true }));
		assert.ok(okta.calls.includes('refresh:direct'));
	});

	test('the session is counted from the call: an auth_time in the claims does not decide { fresh: true }', async (t) => {
		t.mock.timers.enable({ apis: ['Date'], now: START });
		const h = makeAuth({
			store: 'builtin',
			session: { freshAgeSeconds: 60 },
			providers: { appleNative: { type: 'verified' } },
		});
		const b = new Browser();
		await b.request((ctx) =>
			h.auth.signInVerified('appleNative', { subject: 'u-1', claims: { auth_time: START + 86_400_000 } }, ctx),
		);
		await b.request((ctx) => h.auth.requireAuth(ctx, { fresh: true }));

		t.mock.timers.setTime(START + 61_000);
		await assert.rejects(
			b.request((ctx) => h.auth.requireAuth(ctx, { fresh: true })),
			{ name: AuthErrors.ReauthenticationRequired },
		);

		const old = new Browser();
		await old.request((ctx) =>
			h.auth.signInVerified('appleNative', { subject: 'u-2', claims: { auth_time: 1 } }, ctx),
		);
		await old.request((ctx) => h.auth.requireAuth(ctx, { fresh: true }));
	});

	test('removing a verified provider ends its sessions', async () => {
		const before = makeAuth({ store: 'builtin', providers: { magic: { type: 'verified' } } });
		const b = new Browser();
		await b.request((ctx) => before.auth.signInVerified('magic', { subject: 'u-1' }, ctx));
		const cookie = b.cookieHeader();
		assert.ok(cookie);

		const after = makeAuth(
			{ store: 'builtin', providers: { wallet: { type: 'verified' } } },
			{ rootId: before.auth.parent.id },
		);
		assert.strictEqual(await b.request((ctx) => after.auth.getCurrentUser(ctx)), null);
		assert.strictEqual(b.jar.has(after.cookieName), false, 'the cookie is cleared');
		const restored = makeAuth(
			{ store: 'builtin', providers: { magic: { type: 'verified' } } },
			{ rootId: before.auth.parent.id },
		);
		assert.strictEqual(
			await restored.auth.getCurrentUser(makeContext(cookie)),
			null,
			'the row is gone: putting the provider back does not bring the session back',
		);
	});

	test('signOut ends the session', async () => {
		const h = makeAuth({ store: 'builtin', providers: { appleNative: { type: 'verified' } } });
		const b = new Browser();
		await b.request((ctx) => h.auth.signInVerified('appleNative', { subject: 'u-1' }, ctx));
		await b.request((ctx) => h.auth.signOut(ctx));
		assert.strictEqual(await b.request((ctx) => h.auth.getCurrentUser(ctx)), null);
	});

	test('a provider that is not `verified` is refused: 400 ProviderNotConfigured, no session', async () => {
		const h = makeAuth({
			store: 'builtin',
			providers: {
				appleNative: { type: 'verified' },
				okta: { type: 'oidc', issuer: 'https://okta.example.com', clientId: 'c' },
			},
		});
		const b = new Browser();
		await assert.rejects(
			// @ts-expect-error: 'okta' is not a `type: 'verified'` provider.
			b.request((ctx) => h.auth.signInVerified('okta', { subject: 'u-1' }, ctx)),
			{ name: AuthErrors.ProviderNotConfigured, status: 400 },
		);
		assert.strictEqual(b.jar.has(h.cookieName), false);
	});

	for (const [what, identity] of [
		['an empty subject', { subject: '' }],
		['a subject over 255 characters', { subject: 'x'.repeat(256) }],
		['a subject that is not a string', { subject: 42 }],
		['claims that are not an object', { subject: 'u-1', claims: 'email' }],
		['claims that are an array', { subject: 'u-1', claims: ['email'] }],
		['groups that are not strings', { subject: 'u-1', groups: [1] }],
	] as const) {
		test(`${what} is refused before anything is stored`, async () => {
			const h = makeAuth({ store: 'builtin', providers: { appleNative: { type: 'verified' } } });
			const b = new Browser();
			await assert.rejects(
				// @ts-expect-error: what an untyped caller could pass.
				b.request((ctx) => h.auth.signInVerified('appleNative', identity, ctx)),
				{ name: AuthErrors.InvalidParameter, status: 400 },
			);
			assert.strictEqual(b.jar.has(h.cookieName), false);
		});
	}
});

describe("type: 'verified' in the options", () => {
	test('a verified provider is not a redirect provider: getSignInUrl refuses a block that has only that', async () => {
		const h = makeAuth({ store: 'builtin', providers: { appleNative: { type: 'verified' } } });
		await assert.rejects(
			// @ts-expect-error: no redirect provider is configured.
			new Browser().request((ctx) => h.auth.getSignInUrl(ctx, 'appleNative')),
			{ name: AuthErrors.NoFederatedProvider, status: 409 },
		);
	});

	test('the default store refuses it and names the store that accepts it', () => {
		assert.throws(
			// @ts-expect-error: `type: 'verified'` is not a default-store provider.
			() => resolveOptions({ providers: { appleNative: { type: 'verified' } } }, 'auth'),
			/providers\.appleNative has `type: 'verified'`, which needs `store: 'builtin'`/,
		);
	});

	test("a verified provider id with ':' is refused: two providers could otherwise produce one userId", () => {
		assert.throws(
			() => resolveOptions({ store: 'builtin', providers: { 'apple:native': { type: 'verified' } } }, 'auth'),
			/providers.*apple:native.*must not contain ':'/s,
		);
	});

	test("a subject may contain ':' and stays whole", async () => {
		const h = makeAuth({ store: 'builtin', providers: { wallet: { type: 'verified' } } });
		const user = await new Browser().request((ctx) =>
			h.auth.signInVerified('wallet', { subject: 'eip155:1:0xabc' }, ctx),
		);
		assert.strictEqual(user.userId, 'verified:wallet:eip155:1:0xabc');
		assert.strictEqual(user.federatedIdentity?.sub, 'eip155:1:0xabc');
	});
});
