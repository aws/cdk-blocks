---
"@aws-cdk-blocks/core": patch
---

The stacked door's hosting tests now expect the edge to use AWS's managed `SecurityHeadersPolicy` by default, matching the `@aws-cdk-blocks/hosting` change. No runtime behavior changes in this package.
