---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/bb-async-job": patch
"@aws-cdk-blocks/bb-cron-job": patch
"@aws-cdk-blocks/create-block": patch
---

The Building Block catalog in the `aws-cdk-blocks` README lists keywords for every block. They come from the `keywords` of each package's `package.json`, without the `aws-blocks` tag that every package carries. Before, the catalog read a `**Keywords:**` line in each README, which only `bb-async-job` and `bb-cron-job` had, so the other 19 rows were blank.

The `bb-async-job` and `bb-cron-job` READMEs no longer have that line. Its terms moved to the `keywords` of each package, so `npm search` finds them too: for example `worker`, `retry` and `batch` for `bb-async-job`, and `schedule`, `periodic` and `recurring` for `bb-cron-job`.

A block scaffolded with `@aws-cdk-blocks/create-block` declares the `aws-blocks` keyword in every mode, not only outside the monorepo. Its README template no longer has a `**Keywords:**` line, and the next steps printed for a block scaffolded in this repository say to add keywords to its `package.json`.
