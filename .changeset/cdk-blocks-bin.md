---
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
---

New apps get short task scripts, such as `"dev": "cdk-blocks dev"`. The scripts call the `cdk-blocks` bin that `aws-cdk-blocks` now installs. Run the tasks with `npm run <task>`, as before. Scripts in the 1.0.0 form, `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- <task>`, keep working. `npm run migrate` shortens each generated one to `cdk-blocks <task>`.
