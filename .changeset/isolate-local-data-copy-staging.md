---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
---

Stage local data migration copies outside the block data by default so interrupted copies do not appear as extra FileBucket objects.
