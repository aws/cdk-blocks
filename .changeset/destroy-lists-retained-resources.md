---
'@aws-cdk-blocks/core': patch
'aws-cdk-blocks': patch
---

`npm run destroy` now lists the resources the production stack kept after it printed `Production stack destroyed!`. The production preset retains the DynamoDB tables and the config access-log bucket, and the destroy used to end without saying so. It reads the stack's `DELETE_SKIPPED` events and prints each kept resource by type and name, with the commands to turn off a table's deletion protection and to empty and remove a bucket. If the events can't be read, the destroy still succeeds and prints a warning.
