---
"@aws-blocks/hosting": patch
"@aws-blocks/core": patch
---

`waf: { webAclArn }` compiles without `enabled`. A web ACL of your own needed a meaningless `enabled` (ignored when `webAclArn` is set), and without it `frontDoor: { features: { waf: { webAclArn } } }` failed with an error naming the stacked door's settings. The `waf` setting now takes the new `HostingWafSettings`: either `enabled` or `webAclArn`. `HostingWafConfig` is unchanged (`enabled` stays required), and a door built with `defineFrontDoor` still receives `features.waf.enabled` as a boolean (`false` when only `webAclArn` was given). An empty `webAclArn` without `enabled` now fails synth with `InvalidFrontDoorSettingError` instead of attaching no web ACL.
