---
"@aws-cdk-blocks/bb-async-job": patch
"aws-cdk-blocks": patch
---

Reuse validated JSON payloads when enqueuing local AsyncJob batches so a second serialization cannot fail after some jobs have already been queued.
