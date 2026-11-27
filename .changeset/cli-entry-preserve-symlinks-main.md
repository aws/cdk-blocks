---
"@aws-cdk-blocks/create-block": patch
"@aws-cdk-blocks/create-blocks-app": patch
---

`create-block` and `create-blocks-app` now start when Node runs them with `--preserve-symlinks-main` (also when it is set in `NODE_OPTIONS`) through a symlinked package directory, such as one that `npm link` makes. Before, they exited with code 0 and did nothing in that case.
