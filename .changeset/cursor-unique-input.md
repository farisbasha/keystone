---
'@keystone-6/core': patch
---

Fixes `cursor` arguments not being validated and parsed like unique `where` inputs, invalid cursor values such as a malformed `id` now return a Keystone input error rather than a database error
