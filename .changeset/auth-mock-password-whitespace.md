---
"@aws-cdk-blocks/bb-auth": patch
"aws-cdk-blocks": patch
---

The local user pool now refuses a password that begins or ends with whitespace, as Cognito does. `signUp`, `confirmResetPassword`, `updatePassword`, `auth.admin.setUserPassword` and the `temporaryPassword` of `auth.admin.createUser` answer `InvalidParameterException` (status 400) for such a password under `npm run dev` and in tests, the same answer Cognito gives on AWS. Before, the local user pool stored the password, so a sign-up that worked locally failed after deploy. Whitespace inside a password is still allowed.
