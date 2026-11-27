---
"@aws-cdk-blocks/core": patch
---

`ApiError` now stores and sends a status that is not an integer from 100 to 599 (such as `99`, `600` or `1.5`) as `500`, in local dev and on AWS, so the client's `e.status` and a RawRoute's HTTP response status are always valid HTTP status codes.
