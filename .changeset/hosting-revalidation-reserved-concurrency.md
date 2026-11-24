---
"@aws-cdk-blocks/hosting": patch
"@aws-cdk-blocks/core": patch
---

Add `compute.revalidation.reservedConcurrency` to cap the ISR revalidation worker Lambda. It's opt-in, and the default is still no reservation. A reservation of 2 or more also caps the worker's SQS event source at the same concurrency, so messages beyond it wait in the queue instead of being throttled into the dead-letter queue. The hosting README now has a "Reserved concurrency" section. It lists which hosting Lambdas each option covers, explains the throttling and account-pool trade-off, and names the functions it doesn't apply to (Lambda@Edge, Web Functions, door helpers).
