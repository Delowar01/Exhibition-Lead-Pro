---
name: DESIGN subagent structural JSX bugs
description: Recurring failure modes when DESIGN subagents modernize RN/Expo screens — verify structure, not just claims.
---

Rule: after any DESIGN subagent edit to React Native screens, run typecheck AND grep the diff for container structure before trusting "success".

**Why:** Across Stage 5.9 waves, subagents repeatedly (a) claimed success while editing nothing, (b) left mismatched closing tags (`</View>` vs `</Card>`), and (c) inserted a duplicate nested `<ScrollView>` opening (copying the outer scroller's props) without a matching close — breaking the parse hundreds of lines later with misleading error locations.

**How to apply:**
- Verify with `git --no-optional-locks status --short` that files actually changed.
- Typecheck the package; parse errors reported deep in a file usually mean a duplicated/unclosed container near the top of the JSX return.
- When integrating a shared header component over a `Stack.Screen`, hide the native header once the record loads (`headerShown: !record`) or you get double headers/back buttons.
- Watch for shared components imported but not actually wired (custom implementation left in place).
