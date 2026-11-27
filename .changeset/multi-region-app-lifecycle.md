---
'@aws-cdk-blocks/core': patch
'@aws-cdk-blocks/hosting': patch
'@aws-cdk-blocks/pipeline': patch
'aws-cdk-blocks': patch
---

`npm run deploy` and `npm run destroy` now handle an app whose `Hosting` adds a second stack in us-east-1 for the CloudFront 5xx alarm (an app outside us-east-1 whose stack has a resolved `env`).

- **Destroy.** `npm run destroy` deletes the production stack and the CloudFront monitoring stack Hosting added for it, from the assembly it checked, and nothing else. Before, it passed no stack to `cdk destroy`, which refuses an app with two stacks. It stops before deleting when another stack depends on the production stack, and lists the stacks the production stack depended on, which it never deletes. A destroy that stopped halfway can be run again.
- **Destroy retry.** When a production destroy fails and retries, it no longer empties every S3 bucket of the app's stacks. It empties only a bucket that CloudFormation could not delete in that attempt because it still holds objects, so a bucket the stack retains keeps its data. Both destroy commands make their own AWS calls with the credentials CDK uses (access keys before `AWS_PROFILE`), only in the account those credentials were verified for, and name that account as the expected bucket owner.
- **Deploy.** `npm run deploy` synthesizes first, checks that CDK is bootstrapped in every Region the app's stacks deploy to, then deploys that assembly. A missing bootstrap in us-east-1 now stops the deploy before anything is created, with the `cdk bootstrap` command to run.
- **Two commands in one checkout.** Each deploy and destroy synthesizes into its own directory under `.cdk-blocks-sandbox/` and reads its own outputs file, then copies the assembly to `cdk.out` (or `output` in `cdk.json`) and replaces `outputs.production.json` after a successful deploy. `deploy`, `destroy`, `sandbox`, `sandbox:deploy` and `sandbox:preview` hold a lock (`.cdk-blocks-sandbox/synth.pid`) while they generate the client and synthesize; a second command started meanwhile stops at once and names the first.
- **Hosting.** The us-east-1 monitoring stack no longer raises aws-cdk-lib's `@aws-cdk/core:crossStackReferencesDefaultStrong` warning: it sets the cross-stack reference strength to `strong`, the default, unless the app chose one.
- **Pipeline.** Inside a pipeline, an app file that passes `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` to its stack gets the stage's account and Region, not those of the pipeline's own synth.

With `BLOCKS_LOG_LEVEL` unset, `verbose` or `debug`, a deploy prints the CDK CLI's synth lines and each construct warning twice (once for the synth, once for the deploy). A `build` command in `cdk.json` still runs once.
