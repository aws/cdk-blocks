---
"@aws-cdk-blocks/core": patch
"aws-cdk-blocks": patch
"@aws-cdk-blocks/create-blocks-app": patch
---

`npm run deploy` and `npm run sandbox` (`cdk-blocks deploy` and `cdk-blocks sandbox`, at every log level), including each deployment of the sandbox's watch mode, now explain when AWS denies a request of the deployment itself, for example a CloudFormation resource that fails with `is not authorized to perform`. The explanation names the command that ran and follows as soon as the failure is reported, without waiting for CloudFormation's rollback, and once per deployment; `--quiet` does not hide it. It says whether an AWS Organizations policy (a service control policy or a resource control policy) explicitly denied the request, which signing in again or adding IAM permissions does not change. It contains none of the error's account IDs, ARNs or policy IDs, and the commands fail with the same output, errors and exit codes as before. The CDK CLI's hard-wrapped error lines, terminal colors, CRLF line endings and the `AuthorizationError` and `UnauthorizedOperation` errors are recognized; the CDK CLI's note that names AccessDenied as an example of what `cdk diagnose` finds, resource names, and app logs in watch mode are not treated as a denial.

After such a failure, the recovery guidance of `npm run sandbox` does not risk the sandbox's data: it never suggests `npm run sandbox:destroy`. Where it would otherwise recommend a destroy (a stack left in a failed state, such as the Express Mode note, or a stack state that cannot be read), it now says to run `npm run sandbox` again once the cause is resolved, and not to destroy the sandbox. The guidance for a locked sandbox output, a stack that is still updating, a failed synth and a sandbox without a failed stack is unchanged, as is the guidance after other failures.

When credentials expire or are rejected during `npm run sandbox`, including in its watch mode, the sandbox now prints the sign-in guidance of the pre-deploy credential check for the profile or access keys that it deploys with, once per deployment, and says whether saving a file or restarting `npm run sandbox` picks up the new credentials.

The initial sandbox deploy now passes `--progress events` to `cdk deploy`, so its CDK output has one line per CloudFormation event (as `npm run deploy` does) instead of a progress bar.
