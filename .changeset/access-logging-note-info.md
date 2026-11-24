---
'@aws-cdk-blocks/core': patch
'aws-cdk-blocks': patch
---

`blocks:apigateway:access-logging-disabled` is now an info, not a warning. It reports that a deployment with a durable removal policy has API Gateway access logging off, which is the default of `BlocksPresets.production`, so every app that kept the preset got a warning and failed `cdk synth --strict`. The info is still printed on every synth of such a deployment. To hide it, call `Annotations.of(stack).acknowledgeInfo('blocks:apigateway:access-logging-disabled')` on the stack or backend that `create()` returns; an existing `acknowledgeWarning` call with the same id keeps working. The default and the synthesized template are unchanged.
