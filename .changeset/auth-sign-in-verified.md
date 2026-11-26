---
'@aws-cdk-blocks/bb-auth': minor
'aws-cdk-blocks': minor
---

`Auth` can open a session for an identity your own backend code verified: a native Sign in with Apple identity token, a magic link, a wallet signature. Declare a `type: 'verified'` provider on a `store: 'builtin'` block and call `auth.signInVerified(providerId, { subject, claims?, groups? }, context)` once your check has passed. The session cookie, the session record, `validateUser`, `onSignIn` and the audit records are those of any other sign-in.

- The block verifies nothing here: it trusts the identity you pass.
- The user's `userId` is `verified:<providerId>:<subject>`, so it can never equal another provider's. The provider id must not contain `:`.
- The session lasts `session.ttlSeconds` from sign-in. Nothing extends it, and removing the provider from `providers` ends its sessions.
- `iss`, `sub` and `auth_time` in the claims you pass are ignored: the block sets them.
- A `type: 'verified'` provider has no sign-in route and no `signIn:<id>` action, and `getSignInUrl()` does not accept its id. `signInVerified()` is a compile error on a block without such a provider.
