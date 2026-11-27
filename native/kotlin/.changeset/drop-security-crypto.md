---
"aws-cdk-blocks-kotlin": patch
---

Drop the `androidx.security:security-crypto` dependency from the Android runtime. A credential file left by 0.2.0 is no longer read; it is deleted on first use. Users upgrading from 0.2.0 or earlier sign in once more, as they already did when upgrading to 1.0.0: the cookie jar 1.0.0 introduced never read the entries 0.2.0 stored. Upgrades from 1.0.0 keep their session.
