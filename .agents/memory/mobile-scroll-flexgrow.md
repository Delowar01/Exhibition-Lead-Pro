---
name: Mobile scroll flexGrow pattern
description: All vertical ScrollView/FlatList/KeyboardAwareScrollView containers need flexGrow:1 on contentContainerStyle or drag-over-empty-space does nothing on iOS/Android.
---

## The rule

Every primary vertical `ScrollView`, `FlatList`, or `KeyboardAwareScrollView` in the mobile app must have `flexGrow: 1` in `contentContainerStyle`. Without it, the scrollable content area only occupies the height of its children — dragging on empty space below the last item does nothing because the touch hits the parent non-scrollable View.

Also add `keyboardShouldPersistTaps="handled"` on the same container so tapping a button while the keyboard is open doesn't dismiss it first.

**Why:** This is a well-known React Native gotcha. `contentContainerStyle={{ flexGrow: 1 }}` makes the scroll content fill at least the full scroll container height, so the entire visible area is a valid drag target.

## Do NOT use scrollEnabled gates

Avoid `scrollEnabled={list.length > 0}` or similar patterns. These gates:
- Prevent pull-to-refresh on empty state
- Are the wrong fix for "nothing to scroll" (use `ListEmptyComponent` instead)
- Cause user confusion when pull-to-refresh silently does nothing

Remove these gates and rely on `flexGrow: 1` + the list's built-in empty state handling.

**How to apply:** When adding a new scrollable screen, always include `contentContainerStyle={{ ..., flexGrow: 1 }}` from the start. When debugging scroll issues on a screen, check contentContainerStyle first.
