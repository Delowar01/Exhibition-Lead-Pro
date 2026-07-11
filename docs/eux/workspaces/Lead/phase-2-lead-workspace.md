# ============================================================================
# Lead Capture Pro
# Phase 2 – Lead Workspace
# Enterprise UX Implementation Specification
# Version: 1.0
# Status: Approved
# ============================================================================

---

# 1. Objective

Implement the Lead Workspace exactly as shown in the approved UI.

This workspace is responsible for converting prospects into qualified opportunities.

Unlike the Contact Workspace, this screen focuses on qualification, engagement, conversion probability and sales progression.

The design should feel premium, fast and information rich without overwhelming users.

---

# 2. Design Goal

The Lead Workspace should answer five questions immediately.

• Who is this lead?

• How qualified is this lead?

• How engaged is this lead?

• What should happen next?

• How likely is conversion?

Users should understand the health of a lead within five seconds.

---

# 3. Screen Layout

Desktop Layout

```
Global Header

Left Navigation

Lead Hero

Workspace Tabs

Main Workspace (70%)

Right Sidebar (30%)
```

The workspace uses a two-column responsive layout.

The right sidebar always remains visible on desktop.

---

# 4. Lead Hero

Displays

• Lead Avatar

• Lead Name

• Company

• Lead Status

• Lead Source

• Lead Owner

• Lead Score

• Created Date

• Last Activity

Primary Actions

Convert

Follow Up

Email

WhatsApp

More

The hero remains fixed while switching tabs.

---

# 5. Workspace Tabs

Tabs

Overview

Timeline

Activities

Documents

Interactions

AI Workspace

Qualification

Notes

Switching tabs should never reload the page.

Only the workspace content changes.

---

# 6. Overview Workspace

Contains the following sections.

Lead Summary

Lead Information

Engagement Overview

Lead Qualification

Key Insights

Next Best Actions

Recent Activities & Timeline

These sections remain in the same order as the approved UI.

---

# 7. Right Sidebar

Contains

Lead Status Progress

Lead Score Breakdown

Related Records

Owner & Team

The sidebar remains visible while scrolling.

The sidebar should not reload when switching workspaces.

---

# 8. Lead Status

Display the lead lifecycle as a horizontal progress indicator.

Stages

New

Contacted

Qualified

Proposal

Converted

Only one stage is active.

Completed stages remain highlighted.

Future stages remain inactive.

Users with permission can update the stage.

---

# 9. Lead Score

Display overall score.

Example

78 / 100

Display category breakdown.

Profile Fit

Engagement

Activity

Intent

Each metric uses a horizontal progress indicator.

Scores are calculated by existing backend services.

Do not recalculate on the frontend.

---

# 10. Engagement Overview

Display engagement trend using a line chart.

Selectable periods

7 Days

30 Days

90 Days

1 Year

Chart updates instantly.

No page refresh.

---

# 11. Lead Qualification

Display BANT qualification.

Budget

Authority

Need

Timeline

Fit

Each item uses a five-level rating indicator.

These ratings are editable.

---

# 12. Key Insights

Display deterministic insights first.

Examples

Lead visited pricing page.

Downloaded proposal.

Opened campaign email.

Requested demo.

High website engagement.

These insights are generated without AI whenever possible.

---

# 13. Next Best Actions

Display action cards.

Examples

Schedule Demo

Send Case Study

Call Lead

Each action contains

Action Name

Business Impact

Primary Button

Selecting an action opens the corresponding workflow.

---

# 14. Related Records

Quick navigation to

Company

Contact

Activities

Documents

Interactions

Selecting a record opens it without losing Lead Workspace state.

---

# 15. Owner & Team

Display

Lead Owner

Supporting Team

Profile Photos

Quick Assign

Role

The owner can be reassigned from this panel.

---

# 16. AI Behaviour

AI is integrated but never dominates the interface.

AI should only generate

Executive Summary

Sales Recommendations

Email Drafts

Meeting Preparation

Objection Handling

Proposal Summary

Relationship Analysis

AI generation begins only after explicit user action.

Deterministic calculations must never call AI.

---

# 17. Responsive Behaviour

Desktop

Two-column layout.

Tablet

Sidebar becomes collapsible.

Mobile

Single-column layout.

Sidebar becomes bottom sheet.

Tabs become horizontally scrollable.

---

# 18. Performance

Target

Workspace switch

<150ms

No unnecessary API requests.

Cache

Tabs

Charts

Sidebar

Lead Summary

Do not rerender Header or Navigation.

---

# 19. Accessibility

WCAG AA

RTL

Keyboard Navigation

Visible Focus States

Screen Reader Support

Touch Targets ≥44px

---

# 20. Acceptance Criteria

✓ Layout matches approved design.

✓ Existing Lead functionality remains unchanged.

✓ APIs remain unchanged.

✓ Existing permissions continue working.

✓ Responsive layout implemented.

✓ Sidebar remains persistent.

✓ AI is user initiated.

✓ Performance targets achieved.

✓ No TypeScript errors.

✓ No console errors.

---

# Implementation Notes for Replit

Implement this screen exactly as shown in the approved image.

Do not redesign.

Do not change spacing.

Do not move cards.

Reuse existing components wherever possible.

Preserve all existing backend logic, APIs, permissions and workflows.

This task is a UX implementation only.