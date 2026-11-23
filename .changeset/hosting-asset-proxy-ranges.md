---
'@aws-cdk-blocks/hosting': patch
'aws-cdk-blocks': patch
---

The ALB and API Gateway doors' asset proxy now answers byte-range requests: a single `Range` (`bytes=0-9`, `bytes=500-`, `bytes=-500`) is read from S3 as that range and answered with `206 Partial Content` and `Content-Range` (never gzipped), and every file response carries `Accept-Ranges: bytes`. A range longer than the door's response limit allows, including a browser's first media request `bytes=0-`, is shortened to what fits (about 704 KiB on ALB, 4.4 MiB on API Gateway; `maxRangeBytes` in `AssetProxyOptions` overrides it) and the client asks for the rest, so video and audio seeking and resumable downloads of static files of any size work behind these doors, as on the CloudFront door. A range no byte of the file satisfies (past the end, `bytes=-0`) is a `416`. Several ranges, a malformed range, or an `If-Range` that names another version of the file get the whole file (`200`).
