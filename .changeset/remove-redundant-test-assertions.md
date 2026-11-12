---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
"@aws-cdk-blocks/hosting": patch
"@aws-cdk-blocks/auth-common": patch
"@aws-cdk-blocks/bb-auth": patch
"@aws-cdk-blocks/bb-agent": patch
"@aws-cdk-blocks/bb-app-setting": patch
"@aws-cdk-blocks/bb-container-compute": patch
"@aws-cdk-blocks/bb-email-client": patch
"@aws-cdk-blocks/bb-file-bucket": patch
"@aws-cdk-blocks/bb-logger": patch
"@aws-cdk-blocks/bb-metrics": patch
"@aws-cdk-blocks/bb-realtime": patch
"@aws-cdk-blocks/bb-tracer": patch
---

Remove test assertions that duplicate what each test already checks about the current behavior. Tests only; no behavior change.
