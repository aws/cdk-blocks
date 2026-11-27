---
'@aws-cdk-blocks/create-blocks-app': patch
'aws-cdk-blocks': patch
---

A new app from `create-blocks-app` passes the account and Region the CDK CLI deploys to as its stack's `env`. With `Hosting`, an app deployed outside us-east-1 now gets a working CloudFront 5xx alarm, in a second stack in us-east-1 (`<stack>-CfMonitoring-<hash>`), and no longer gets the `@aws-cdk-blocks/hosting:CloudFrontAlarmRegionUnresolved` warning. us-east-1 then needs a CDK bootstrap too: `npm run deploy` checks it before it deploys and prints the command. An app deployed to us-east-1 is unchanged, and so is an existing app; "A `Hosting` app deployed outside us-east-1" in `docs/guides/upgrading-older-apps.md` shows the one line to add.
