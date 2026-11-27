---
"aws-blocks-kotlin": patch
---

Generated clients now build for Android when a spec name contains a character Android can't load, such as a space, `'` or `#`. Such names are now generated from their words, so `with space` becomes `withSpace`.
