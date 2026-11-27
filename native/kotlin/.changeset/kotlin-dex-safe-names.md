---
"aws-blocks-kotlin": patch
---

Generated clients build for Android when a spec name holds a character DEX rejects before version 040, such as a space, `'`, `#`, `+` or `,`. Kotlin compiled such a name in backticks, but `d8` failed the Android build ("Field name 'c#' cannot be represented in dex format"). The property, parameter, operation, server or type is now named after its words (`with space` is `withSpace`), and the wire keeps the spec name.
