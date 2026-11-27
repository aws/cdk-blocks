---
'@aws-cdk-blocks/hosting': patch
'aws-cdk-blocks': patch
---

A Nuxt (Nitro) route rule with `isr` and no `swr` or `cache` now prints a warning at build that names the route. Nitro implements `isr` only in its Vercel, Netlify and Zeabur presets, so on AWS such a route was not cached, without a word. Not named: a rule that also sets `prerender: true` (served from S3), the `_payload.json` rule Nuxt adds for a named route, and a route under a broader `swr` or `cache` rule. The warning, and the README, point to `swr: <seconds>`, which caches the page at the edge.
