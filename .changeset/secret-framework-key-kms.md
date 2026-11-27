---
"@aws-cdk-blocks/bb-secret": patch
"aws-cdk-blocks": patch
---

A framework-generated key in Secrets Manager (such as the `Auth` session secret) now grants the execution role `kms:Decrypt` through Secrets Manager when the secret has a customer-managed key, so reads no longer fail with `AccessDeniedException`.
