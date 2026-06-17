---
name: esbuild nullish coalescing
description: Mixing ?? and || without parens causes esbuild parse errors
---

esbuild (used for the api-server bundle) rejects expressions that mix `??` and `||` at the same precedence level without explicit parentheses.

**Wrong:**
```ts
c.fullName ?? [c.firstName, c.lastName].filter(Boolean).join(" ") || null
```

**Correct:**
```ts
c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || null)
```

**Why:** This is a JavaScript spec ambiguity — the parser requires explicit grouping to avoid confusion between nullish coalescing and logical OR.

**How to apply:** Any time you write `expr1 ?? expr2 || expr3`, wrap the `??` RHS in parens: `expr1 ?? (expr2 || expr3)`.
