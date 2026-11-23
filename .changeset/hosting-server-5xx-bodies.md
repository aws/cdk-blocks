---
"@aws-cdk-blocks/hosting": patch
"aws-cdk-blocks": patch
---

The CloudFront door no longer replaces 500 and 503 responses with the built-in "Service Temporarily Unavailable" page for an app with a server, so an API route's JSON error and the framework's own error page reach the client with their status. Two other responses pass through the same way: a 500 that API Gateway answers in front of the server (for example `{"message": "Internal server error"}` when the function is throttled), and a 503 that CloudFront generates itself (a CloudFront Function or Lambda@Edge error), which now carries CloudFront's default error body. The built-in page now answers only 502 and 504: the responses CloudFront generates when the server function fails or times out, and any 502 or 504 body the server sends itself. `errorPages.serverError` still maps 500 to the app's page. None of these responses are cached.
