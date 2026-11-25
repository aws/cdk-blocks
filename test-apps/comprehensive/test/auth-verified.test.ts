// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `signInVerified()`: the app checks a credential itself and the
 * `auth-verified` block (`store: 'builtin'`, a `type: 'verified'` provider)
 * opens the session, through the generated client and the session cookie.
 * The credential here is the e2e build's test-support secret, so the sign-in
 * method lives in the secret-gated `testSupport` namespace.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'cdk-blocks';
import { callTestSupport, getTestSupport } from './test-support.js';

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function authVerifiedTests(getApi: () => typeof apiType) {
  describe('Auth signInVerified — a session for an identity the app verified (auth-verified)', () => {
    test('a credential the app accepts opens a session; sign-out ends it', async () => {
      const api = getApi();
      const { testSupport, secret } = await getTestSupport();
      const subject = `u${unique()}`;
      const signedIn = await testSupport.verifiedSignIn(secret, subject);
      assert.deepStrictEqual(signedIn, { userId: `verified:ticket:${subject}`, provider: 'ticket' });

      assert.deepStrictEqual(await api.verifiedCurrentUser(), {
        userId: `verified:ticket:${subject}`,
        email: `${subject}@verified.example`,
        provider: 'ticket',
      });

      await api.verifiedSignOut();
      assert.strictEqual(await api.verifiedCurrentUser(), null);
    });

    test('a credential the app refuses opens no session', async () => {
      const api = getApi();
      const body = await callTestSupport('verifiedSignIn', ['not-the-secret', `u${unique()}`]);
      assert.strictEqual(body.error?.code, 403, `Unexpected response: ${JSON.stringify(body)}`);
      assert.strictEqual(await api.verifiedCurrentUser(), null);
    });
  });
}
