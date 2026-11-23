---
"@aws-cdk-blocks/hosting": patch
"aws-cdk-blocks": patch
---

The stacked door's edge now uses the CloudFront door's security headers. By default that is AWS's managed `SecurityHeadersPolicy`, so a security header the server sets itself (for example `X-Frame-Options: DENY` from middleware) reaches the browser instead of being replaced at the edge. The edge no longer adds a default `Content-Security-Policy`, and its default `Strict-Transport-Security` is the managed policy's (`max-age=31536000`, and a server-set value wins), as on the CloudFront door. To keep a CSP on responses that don't carry one, emit it from the app, or set `features.edge.contentSecurityPolicy` (the edge then sets that CSP and fixed values for the other security headers, which replace the server's). With `features.edge.contentSecurityPolicy` set, the edge gets the same custom policy as the CloudFront door with `contentSecurityPolicy`. The edge also no longer creates its own response headers policy by default, so it uses none of the account's response headers policy quota.
