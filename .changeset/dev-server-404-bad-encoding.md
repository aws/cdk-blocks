---
"@aws-cdk-blocks/core": patch
---

The local dev server now answers like the deployed API in two cases. A request path with malformed percent-encoding (such as `/users/%E0%A4%A`) gets a 400 with `{"error":"Bad Request"}` instead of reaching the RawRoute handler with the undecoded text as its parameter. A request that matches no route, when no frontend dev server is running, gets a 404 with `{"error":"Not Found"}` and `Content-Type: application/json` instead of an empty body.
