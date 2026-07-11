# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 1 — Foundation
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 1. Purpose

The Contact Workspace is the most frequently used screen in Lead Capture Pro.

It is the single source of truth for every customer relationship.

Every action performed by a sales representative should either begin here or end here.

The Contact Workspace must allow users to understand the complete relationship with a customer within a few seconds without navigating through multiple pages.

The workspace is designed around one principle:

> One screen.
> Everything important.
> Zero confusion.

---

# 2. Primary Objectives

The Contact Workspace must enable users to:

• Understand who the contact is.

• Understand the health of the relationship.

• View every interaction.

• Take immediate action.

• Access every related document.

• Understand AI recommendations.

• Continue the sales journey without leaving the page.

The workspace should minimize navigation.

The majority of daily CRM tasks should be completed from this screen.

---

# 3. Design Principles

The following principles are mandatory.

## 3.1 Information First

Information is always more important than decoration.

Avoid unnecessary graphics.

Avoid visual noise.

---

## 3.2 One Decision Per Section

Every section answers exactly one business question.

Example:

Contact Summary

Who is this person?

Relationship Health

How healthy is this relationship?

AI Assistant

What should I do next?

Documents

Do I already have everything needed?

Interaction History

How did this relationship evolve?

---

## 3.3 Progressive Disclosure

Do not overwhelm users.

Display only essential information first.

Allow expansion only when requested.

---

## 3.4 Immediate Actions

Users should never search for common actions.

Primary actions remain visible.

Call

WhatsApp

Email

Schedule Follow-up

must always be accessible.

---

## 3.5 Zero Dead Space

Every section must provide business value.

Avoid decorative spacing.

Avoid oversized headers.

Avoid large empty cards.

---

# 4. Screen Architecture

Desktop Layout

```
+--------------------------------------------------------------------------+
| Global Header                                                            |
+--------------------------------------------------------------------------+

| Left Navigation |                Contact Workspace          | AI Sidebar |
|                 |                                           |            |
|                 | Contact Hero                              |            |
|                 |-------------------------------------------|            |
|                 | Workspace Tabs                            |            |
|                 |-------------------------------------------|            |
|                 | Active Workspace Content                  |            |
|                 |                                           |            |
|                 |                                           |            |
|                 |                                           |            |
|                 |                                           |            |
+--------------------------------------------------------------------------+
```

The AI Sidebar remains visible while users navigate between tabs.

The Contact Hero remains fixed at the top of the workspace.

Workspace Tabs remain sticky while scrolling.

---

# 5. Workspace Hierarchy

The Contact Workspace consists of six major regions.

1.
Global Header

2.
Left Navigation

3.
Contact Hero

4.
Workspace Tabs

5.
Workspace Content

6.
AI Sidebar

No additional permanent regions are permitted.

---

# 6. Navigation Philosophy

Navigation should be shallow.

Users should never require more than three clicks to reach any information related to a contact.

Deep page hierarchies are prohibited.

Modal dialogs should be used only for focused tasks.

---

# 7. Layout Grid

Desktop

Resolution Target

1920 × 1080

Maximum Content Width

Fluid

Minimum Width

1440 px

Grid

12-column responsive grid

Content Margin

24 px

Card Gap

20 px

Card Padding

24 px

Border Radius

16 px

---

Tablet

Content collapses into two columns.

AI Sidebar moves below the workspace.

---

Mobile

Single-column layout.

Hero becomes compact.

Tabs become horizontally scrollable.

AI Sidebar becomes an expandable bottom sheet.

---

# 8. Workspace Regions

## Region 1

Global Header

Purpose

Global application controls.

Contains

• Search

• Notifications

• Theme Toggle

• User Profile

• Workspace Switch

Height

64 px

Sticky

Yes

---

## Region 2

Left Navigation

Purpose

Application navigation.

Contains

Dashboard

Contacts

Companies

Events

Activities

Documents

AI Center

Settings

Always visible on Desktop.

Collapsible.

---

## Region 3

Contact Hero

Purpose

Immediately identify the contact.

Contains

Avatar

Full Name

Job Title

Company

Contact Details

Tags

AI Confidence

Quick Actions

Always visible.

---

## Region 4

Workspace Tabs

Contains

Overview

Timeline

Activities

Documents

Interactions

AI

Exactly one tab is active.

---

## Region 5

Workspace Content

Displays the currently selected workspace.

Only one workspace is rendered at a time.

Each workspace manages its own loading and empty states.

---

## Region 6

AI Sidebar

Always visible on Desktop.

Contains

AI Assistant

Generate with AI

AI Insights

CRM Context

The sidebar remains independent from workspace navigation.

Changing tabs must never reload the sidebar.

---

# 9. Performance Requirements

The Contact Workspace is expected to be the most frequently accessed screen in the platform.

Performance is therefore critical.

Requirements:

• Lazy load workspace content.

• Preserve Contact Hero during navigation.

• Preserve AI Sidebar during navigation.

• Render only the active workspace.

• Avoid full page refreshes.

• Avoid layout shifts.

• Maintain smooth scrolling.

---

# 10. Acceptance Criteria

The implementation is considered complete only if:

✓ Contact information is immediately visible.

✓ Users understand where they are.

✓ Primary actions are always accessible.

✓ AI assistance remains visible.

✓ Navigation feels instantaneous.

✓ No unnecessary scrolling occurs.

✓ Every section has a clear business purpose.

✓ The screen matches the approved design.

---

# End of Chapter 1

---------------------------------------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 2 — Global Header & Left Navigation
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 11. Global Header

## Purpose

The Global Header provides universal application controls that remain
consistent across the entire Lead Capture Pro platform.

It should never contain page-specific information.

The header must always remain visible while scrolling.

Height: 64px

Position: Sticky

Top: 0

Z-Index: Highest application layer

Background:

Primary Navigation Color

Border Bottom:

1px Divider

---

# 12. Header Layout

Desktop

```
+--------------------------------------------------------------------------------------+
| Logo | Search | Quick Add | Notifications | Help | Theme | User Profile |
+--------------------------------------------------------------------------------------+
```

Spacing between components must remain consistent.

All controls align vertically.

No component exceeds header height.

---

# 13. Company Logo

Position

Top Left

Contains

• Lead Capture Pro Logo

• Product Name

Click Action

Return to Dashboard

Logo height

36px

Do not animate.

---

# 14. Global Search

Purpose

Instantly search the entire platform.

Placeholder

Search contacts, companies, leads, events...

Shortcut

CTRL + K

Desktop Width

360px

Expandable

No

Search must return

• Contacts

• Companies

• Leads

• Events

• Documents

• Activities

• Business Cards

• AI Conversations

Search results appear in an overlay.

No page navigation while typing.

Search updates instantly.

---

# 15. Quick Add

Purpose

Create records from anywhere.

Button Style

Primary

Orange

Dropdown Items

• Contact

• Lead

• Company

• Activity

• Task

• Event

• Document

• Opportunity

Never exceed one click.

---

# 16. Notifications

Display

Bell Icon

Unread Badge

Maximum badge value

99+

Dropdown contains

Unread

Today

Earlier

Actions

Mark All Read

Open

Dismiss

Notification types

CRM

AI

Workflow

Reminder

Assignment

System

---

# 17. Help Center

Purpose

Quick assistance.

Contains

• Documentation

• Tutorials

• Keyboard Shortcuts

• Contact Support

Opens Drawer.

Never opens new browser tab.

---

# 18. Theme Switch

Modes

Light

Dark

System

Preference stored per user.

Changes entire application instantly.

No page reload.

---

# 19. User Profile

Contains

Avatar

User Name

Role

Dropdown Menu

Profile

Preferences

Organization

API Keys

Billing (Permission Based)

Logout

Profile menu opens below avatar.

---

# 20. Left Navigation

Purpose

Primary application navigation.

Width

Collapsed

72px

Expanded

220px

Desktop

Always visible.

Tablet

Collapsible.

Mobile

Hidden.

Opened using hamburger menu.

---

# 21. Navigation Groups

Group 1

Workspace

• Dashboard

• Contacts

• Leads

• Companies

• Events

• Activities

• Calendar

• Tasks

---

Group 2

Workflow

• Follow-ups

• Reminders

• Sequences

---

Group 3

AI

• AI Assistant

• AI Insights

• Sales Copilot

---

Group 4

Documents

• Documents

• Proposals

• Contracts

---

Group 5

Administration

• Users

• Settings

---

# 22. Navigation Item

Each item contains

Icon

Label

Active Indicator

Hover State

Badge (Optional)

Chevron (If expandable)

Height

48px

Border Radius

12px

Padding

12px Horizontal

---

# 23. Active Navigation State

Active page

Orange Background

White Icon

White Text

Rounded Corners

Active indicator remains visible
until another page is selected.

---

# 24. Hover State

Hover

Light Orange Background

Orange Icon

Orange Text

Animation

150ms

No bounce animation.

---

# 25. Collapse Navigation

Collapse Button

Bottom Left

Collapsed

Icons Only

Expanded

Icons + Labels

User preference saved automatically.

---

# 26. Workspace Persistence

Changing workspace must NOT reset

Search

Notifications

Theme

Navigation State

Collapsed State

User Preferences

These remain persistent throughout the session.

---

# 27. Accessibility

Keyboard Navigation

Enabled

Tab Order

Logical

Search

CTRL + K

Focus Ring

Visible

Touch Targets

Minimum 44px

Screen Reader

Supported

RTL

Supported

---

# 28. Performance Requirements

Header loads once.

Navigation loads once.

Do not re-render during workspace changes.

Only workspace content updates.

Header and Navigation remain mounted.

---

# 29. Acceptance Criteria

✓ Header always visible.

✓ Navigation remains responsive.

✓ Search is accessible globally.

✓ Notifications update without refresh.

✓ Theme changes instantly.

✓ User preferences persist.

✓ Navigation collapse state persists.

✓ Active page clearly indicated.

✓ No unnecessary page reloads.

---

# End of Chapter 2

----------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 3 — Contact Hero & Quick Actions
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 30. Contact Hero

## Purpose

The Contact Hero is the identity and action center of the Contact Workspace.

It must immediately communicate:

• Who the contact is

• Where they work

• Current relationship status

• AI confidence

• Primary communication methods

• Next recommended action

The Contact Hero remains fixed at the top of the workspace.

---

# 31. Layout

Desktop Layout

```
+--------------------------------------------------------------------------------------+
| Avatar | Contact Details | Status & Tags | Quick Actions | Relationship Snapshot |
+--------------------------------------------------------------------------------------+
```

The layout is horizontal.

No internal scrolling.

Height

160–180px

Padding

24px

Background

Surface Card

Border Radius

16px

Shadow

Low Elevation

---

# 32. Avatar

Size

88px × 88px

Shape

Circle

Display Priority

1. Contact Photo

2. Initials

3. Default Avatar

Click Action

View Full Profile Photo

Hover Action

Change Photo (permission based)

---

# 33. Contact Identity

Display

Full Name

Job Title

Department

Company

Location

Typography

Full Name

Heading Large

Bold

Job Title

Body Medium

Company

Body Medium

Secondary Color

Company Name

Clickable

Navigates to Company Workspace

---

# 34. Relationship Status

Display as badges.

Examples

Customer

Prospect

VIP

Decision Maker

Inactive

Partner

Maximum Visible

4

Additional badges collapse into

+N

Status colors follow Design Tokens.

Never hardcode colors.

---

# 35. AI Confidence

Purpose

Shows confidence in CRM completeness.

Display

Circular Progress Indicator

Percentage

Confidence Label

Examples

98%

Excellent

82%

Good

61%

Needs Review

Tooltip

Explains why confidence is reduced.

This value is informational only.

It must never block user actions.

---

# 36. Relationship Snapshot

Display

Relationship Health

Relationship Age

Last Interaction

Owner

Current Pipeline Stage (if applicable)

Each metric appears in a compact summary tile.

Maximum four tiles.

---

# 37. Contact Information

Display

Primary Mobile

Office Phone

Email

Website

LinkedIn

Preferred Language

Hide empty fields.

Never display "N/A".

---

# 38. Quick Actions

Primary Actions

Call

WhatsApp

Email

Schedule Follow-up

Secondary Actions

Create Activity

Create Note

Assign Owner

Share Contact

Export Contact

Save to Device

Actions are displayed as rounded buttons.

Primary actions use filled buttons.

Secondary actions use outlined buttons.

---

# 39. Quick Action Behaviour

Call

Initiates phone call.

WhatsApp

Opens WhatsApp conversation.

Email

Opens default email composer.

Schedule Follow-up

Opens scheduling dialog.

Create Activity

Opens activity drawer.

Create Note

Opens inline note editor.

Assign Owner

Opens owner selector.

Export Contact

Downloads vCard.

---

# 40. Contact Tags

Tags provide quick business context.

Examples

High Value

Exhibition Lead

Repeat Customer

Hot Lead

Enterprise

Maximum Visible

6

Overflow

+N

Tags are selectable filters.

---

# 41. Sticky Behaviour

While scrolling

Avatar reduces to 56px.

Contact Name remains visible.

Primary Actions remain visible.

Relationship Snapshot collapses into icons.

Height reduces smoothly.

No layout jump.

Animation Duration

200ms

---

# 42. Empty States

Missing Photo

Display initials.

Missing Company

Display

"No company assigned."

Missing Contact Methods

Display

"No communication details available."

Provide

Edit Contact button.

---

# 43. Loading State

Avatar Skeleton

Text Skeleton

Button Skeleton

Metric Skeleton

Layout remains stable.

No layout shift.

---

# 44. Error State

If contact cannot be loaded

Display

Illustration

"Unable to load contact."

Actions

Retry

Return to Contacts

---

# 45. Accessibility

Keyboard Navigation

Enabled

Screen Reader

Reads contact summary first.

Touch Targets

Minimum 44px

Contrast

WCAG AA

RTL

Fully supported.

---

# 46. Performance

Contact Hero loads first.

Relationship metrics load asynchronously.

Company logo loads lazily.

AI confidence loads independently.

Primary actions become interactive immediately.

---

# 47. Acceptance Criteria

✓ Contact identity visible within one second.

✓ Primary actions always accessible.

✓ Company navigation works.

✓ AI confidence never blocks interaction.

✓ Sticky behaviour is smooth.

✓ Empty states are meaningful.

✓ Hero matches approved design.

✓ No unnecessary scrolling.

---

# End of Chapter 3

--------------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 4 — Workspace Navigation & Tabs
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 48. Purpose

The Workspace Navigation controls how users move between different business
contexts within a single contact.

Unlike traditional CRM tabs, each tab represents an independent workspace.

Changing workspaces must feel instant.

Users should never feel like they are opening another page.

---

# 49. Available Workspaces

Exactly six workspaces exist.

1.
Overview

Purpose

Executive summary of the relationship.

---

2.

Timeline

Purpose

Complete chronological relationship history.

---

3.

Activities

Purpose

Tasks, meetings, reminders, calls and notes.

---

4.

Documents

Purpose

All files related to the relationship.

---

5.

Interactions

Purpose

Communication history.

Calls

Emails

WhatsApp

SMS

LinkedIn

Meeting records

---

6.

AI Workspace

Purpose

Sales Copilot

Insights

Recommendations

Summaries

Relationship Intelligence

Workflow Intelligence

---

# 50. Workspace Navigation Layout

Desktop

```
 ------------------------------------------------------------

 Overview

 Timeline

 Activities

 Documents

 Interactions

 AI

 ------------------------------------------------------------
```

The navigation appears directly below the Contact Hero.

Height

56px

Sticky

Yes

Spacing

16px

Background

Transparent

Bottom Divider

1px

---

# 51. Navigation Item

Each workspace contains

Icon

Label

Optional Badge

Hover State

Active State

Disabled State

Minimum Width

120px

Height

48px

Border Radius

12px

Padding

16px

---

# 52. Active Workspace

The active workspace displays

Orange Indicator

Bold Text

Orange Icon

Background

Light Orange Surface

Only one workspace may be active.

---

# 53. Hover Behaviour

Hover

Light Background

Orange Icon

Orange Label

Transition

150ms

No bounce animation.

---

# 54. Workspace Persistence

Switching workspaces must NOT reload

Contact Hero

AI Sidebar

Header

Left Navigation

Search

Notifications

Theme

Only the workspace content changes.

---

# 55. Lazy Loading

Workspace content loads only when opened.

Previously visited workspaces remain cached.

Returning to a workspace restores

Scroll Position

Filters

Search

Sorting

Selected Rows

Expanded Sections

---

# 56. Workspace State

Each workspace manages

Loading

Empty

Error

Permission

Offline

independently.

Changing workspaces must never reset another workspace.

---

# 57. Keyboard Navigation

CTRL + 1

Overview

CTRL + 2

Timeline

CTRL + 3

Activities

CTRL + 4

Documents

CTRL + 5

Interactions

CTRL + 6

AI Workspace

Arrow Keys

Move between workspaces.

Enter

Open selected workspace.

---

# 58. Mobile Navigation

Desktop tabs become

Horizontally scrollable pills.

Swipe gesture

Supported.

AI Workspace remains the final tab.

The active workspace stays centered.

---

# 59. Workspace Transition

Transition Style

Cross Fade

Duration

180ms

No full-page loading.

No white flash.

No layout shift.

The Contact Hero remains fixed.

---

# 60. Workspace Permissions

Each workspace respects user permissions.

Examples

Documents

Hidden if access denied.

AI

Hidden if AI module disabled.

Interactions

Read-only if communication permission denied.

Users never see inaccessible actions.

---

# 61. Workspace Notifications

Badges indicate pending work.

Examples

Activities

3

Documents

1

AI

2

Badges disappear immediately
after completion.

---

# 62. Performance Requirements

Workspace switching target

<150ms

No API request when cached.

No rerender of

Header

Sidebar

Hero

AI Sidebar

Only workspace content updates.

---

# 63. Accessibility

Keyboard Navigation

Supported

Screen Reader

Reads active workspace.

ARIA Labels

Required

RTL

Supported

Focus Ring

Visible

Touch Targets

Minimum 44px

---

# 64. Acceptance Criteria

✓ Workspace switching feels instant.

✓ Hero never reloads.

✓ AI Sidebar never reloads.

✓ Previous workspace state is restored.

✓ Keyboard shortcuts work.

✓ Mobile scrolling is smooth.

✓ Navigation matches approved design.

✓ Users always know which workspace is active.

---

# End of Chapter 4

------------------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 5 — Overview Workspace
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 65. Purpose

The Overview Workspace is the default landing screen whenever a contact is opened.

It is not intended to display every piece of CRM information.

Its purpose is to provide a complete executive summary of the relationship.

Within five seconds, the user should understand:

• Who this contact is

• How healthy the relationship is

• What needs attention

• What happened recently

• Whether all required documents exist

• What action should happen next

---

# 66. Layout

Desktop

```
+-----------------------------------------------------------------------------------------------+
| Contact Summary                | Relationship Health                                          |
+--------------------------------+--------------------------------------------------------------+
| Follow-ups                     | Recent Activity                                              |
+--------------------------------+--------------------------------------------------------------+
| Documents                      | Relationship Journey                                         |
+-----------------------------------------------------------------------------------------------+
```

Layout

2 Columns

Card Gap

20px

Card Padding

24px

Cards must align vertically.

Cards must have equal horizontal spacing.

---

# 67. Card Order

The order of cards is fixed.

1.

Contact Summary

2.

Relationship Health

3.

Follow-ups

4.

Recent Activity

5.

Documents

6.

Relationship Journey

No additional cards are permitted.

---

# 68. Contact Summary Card

Purpose

Identify the customer immediately.

Display

• Avatar

• Name

• Job Title

• Company

• Email

• Phone

• Owner

• Tags

Quick Actions

Call

Email

WhatsApp

Open Company

Edit Contact

Card Height

Auto

Minimum Height

220px

---

# 69. Relationship Health Card

Purpose

Show the overall health of the relationship.

Display

Health Score

Relationship Age

Last Interaction

Response Rate

Open Opportunities

Follow-up Status

Relationship Stage

Health Indicator

Healthy

Warning

Critical

Card includes

View Timeline

button.

---

# 70. Follow-up Card

Purpose

Show exactly what requires action.

Display

Primary Follow-up

Upcoming Tasks

Overdue Tasks

Upcoming Meetings

Quick Actions

Complete

Reschedule

Create Task

Add Note

Maximum

4 visible tasks

---

# 71. Recent Activity Card

Purpose

Summarize the latest relationship changes.

Display

Latest Activities

Grouped by date

Today

Yesterday

Earlier

Maximum

5 activities

Each activity contains

Icon

Title

Time

User

Quick Open

---

# 72. Documents Card

Purpose

Indicate relationship readiness.

Display

Recent Documents

Business Cards

Proposal

Quotation

Contract

Meeting Notes

Status

Ready

Partial

Missing Documents

Quick Actions

View All

Upload

---

# 73. Relationship Journey Card

Purpose

Visualize the relationship story.

Display

Timeline

Milestones

Current Stage

Journey Progress

Relationship Age

Maximum

6 milestones

Journey displays

First Contact

First Meeting

First Proposal

Latest Activity

Current Stage

---

# 74. Card Behaviour

Every card follows the same behaviour.

Loading

Skeleton

Empty

Helpful guidance

Error

Retry

Success

Interactive

Cards never reload the entire page.

Only the affected card refreshes.

---

# 75. Card Header

Every card contains

Icon

Title

Optional Subtitle

Context Menu

Refresh (optional)

Headers are visually consistent.

---

# 76. Card Actions

Primary Action

Located bottom right.

Secondary Actions

Context Menu

Buttons remain visible.

No hidden hover-only actions.

---

# 77. Responsive Layout

Desktop

2 Columns

Tablet

2 Compact Columns

Mobile

Single Column

Order

Contact Summary

Relationship Health

Follow-ups

Recent Activity

Documents

Relationship Journey

---

# 78. AI Integration

The Overview Workspace never displays large AI conversations.

Instead, AI appears as compact insight blocks.

Examples

"Customer has not responded in 14 days."

"High probability of proposal acceptance."

"Recommended next action: Schedule follow-up."

Maximum

3 AI Insights

Each insight contains

Reason

Confidence

Suggested Action

AI never replaces CRM data.

AI always supplements CRM data.

---

# 79. Empty Workspace

Display

Illustration

Headline

"This contact has very little activity."

Suggested Actions

Create Activity

Schedule Meeting

Upload Business Card

Import Documents

---

# 80. Loading Behaviour

Each card loads independently.

The page never waits for every card.

Loading sequence

Contact Summary

↓

Relationship Health

↓

Follow-ups

↓

Recent Activity

↓

Documents

↓

Relationship Journey

The user can interact with loaded cards immediately.

---

# 81. Performance Requirements

Target

Under 300ms perceived loading

Independent rendering

Lazy loading

Card-level refresh

Cached content

Zero layout shift

Smooth scrolling

---

# 82. Acceptance Criteria

✓ Overview opens by default.

✓ Six cards appear in the correct order.

✓ Cards remain aligned.

✓ AI supports the user without dominating the screen.

✓ Every card answers one business question.

✓ Mobile order matches specification.

✓ Independent loading works.

✓ Overview matches the approved UI design.

---

# End of Chapter 5

----------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 6 — Timeline Workspace
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 83. Purpose

The Timeline Workspace is the complete historical record of the relationship.

Unlike the Overview Workspace, which summarizes information, the Timeline answers one question:

> **"What happened, when did it happen, and what should happen next?"**

Every meaningful customer interaction must appear here.

The Timeline becomes the legal and operational source of truth for the relationship.

---

# 84. Business Goals

The Timeline must enable users to:

• Understand the complete customer journey.

• Review all historical interactions.

• Quickly locate important events.

• Continue conversations without losing context.

• Audit relationship history.

• Identify periods of inactivity.

• Discover missed follow-ups.

---

# 85. Screen Layout

Desktop

```
+----------------------------------------------------------------------------------------------+
| Timeline Toolbar                                                                            |
+----------------------------------------------------------------------------------------------+

| Timeline Feed                                         | Event Preview                        |
|                                                       |                                      |
|                                                       | Selected Event Details               |
|                                                       | Related Contact                      |
|                                                       | Documents                            |
|                                                       | AI Summary                           |
|                                                       | Quick Actions                        |
|                                                       |                                      |
+----------------------------------------------------------------------------------------------+
```

Desktop Ratio

Timeline Feed

70%

Preview Panel

30%

The Preview Panel remains visible while browsing.

---

# 86. Timeline Toolbar

The toolbar remains sticky.

Contains

• Search

• Date Filter

• Event Type Filter

• Owner Filter

• AI Summary

• Export Timeline

• Refresh

Toolbar Height

56px

No horizontal scrolling on desktop.

---

# 87. Search

Purpose

Instantly search every timeline event.

Search Scope

• Notes

• Calls

• Emails

• WhatsApp

• Activities

• Meetings

• Documents

• OCR Text

• AI Notes

Results update instantly.

No page reload.

Keyboard Shortcut

CTRL + F

---

# 88. Timeline Groups

Events are grouped automatically.

Order

Today

Yesterday

This Week

Last Week

This Month

Older

Groups are collapsible.

Collapsed state is remembered.

---

# 89. Timeline Event Card

Every event appears as a compact card.

Each card contains:

• Event Icon

• Event Title

• Short Description

• Timestamp

• User

• Related Company

• Event Type

• Status Badge

• Quick Actions

Maximum Height

96px

Cards expand only when selected.

---

# 90. Supported Event Types

The Timeline supports:

• Business Card Scan

• Contact Created

• Contact Updated

• Call

• Email

• WhatsApp

• SMS

• Meeting

• Note

• Activity

• Task

• Reminder

• Proposal Sent

• Proposal Approved

• Proposal Rejected

• Quotation Sent

• Opportunity Created

• Opportunity Won

• Opportunity Lost

• Document Uploaded

• Assignment Changed

• Status Changed

• OCR Corrected

• AI Recommendation

• Workflow Automation

• System Event

The architecture must allow future event types without redesigning the UI.

---

# 91. Event Priority

Priority Levels

Critical

High

Normal

Information

Completed

Priority is indicated using:

• Icon

• Badge

• Color

Never rely only on color.

---

# 92. Event Preview Panel

Selecting an event updates the Preview Panel instantly.

Display

• Full Description

• Attachments

• Participants

• Related Company

• Related Documents

• Linked Activities

• AI Summary (when available)

• Internal Notes

• Audit Information

The Preview Panel never navigates away from the Timeline.

---

# 93. Quick Actions

Every event supports contextual actions.

Possible Actions

Open

Edit

Duplicate

Download

Share

Assign

Call

Email

WhatsApp

Create Follow-up

Delete (Permission Based)

Unavailable actions remain hidden.

---

# 94. Timeline Intelligence

Without using AI, the Timeline calculates:

• Relationship Age

• Last Contact

• Longest Inactivity

• Average Response Time

• Total Meetings

• Total Calls

• Total Emails

• Total Documents

• Total Opportunities

These calculations are deterministic.

No AI usage required.

---

# 95. AI Timeline Summary

AI is optional.

Collapsed by default.

The user explicitly clicks:

Generate Relationship Summary

The AI returns:

• Executive Summary

• Important Milestones

• Customer Sentiment

• Potential Risks

• Recommended Next Action

This feature is generated on demand only.

Never automatically.

This minimizes AI cost.

---

# 96. Empty State

Illustration

Headline

"No timeline events found."

Suggested Actions

• Add Note

• Schedule Activity

• Upload Business Card

• Record Meeting

---

# 97. Loading State

Skeleton Timeline Cards

Skeleton Preview

Toolbar remains interactive.

Previously loaded content remains visible until refresh completes.

---

# 98. Error State

Illustration

Message

"Timeline could not be loaded."

Actions

Retry

Return to Overview

Errors never crash the workspace.

---

# 99. Responsive Behaviour

Desktop

Two-column layout.

Tablet

Preview collapses into slide-over drawer.

Mobile

Single-column feed.

Selecting an event opens a full-screen detail sheet.

Toolbar filters move into a bottom sheet.

---

# 100. Performance

Requirements

Virtual Scrolling

Incremental Loading

Card-level Rendering

Cached Search

Lazy Preview Loading

No Layout Shift

Target

<150ms interaction latency.

---

# 101. Accessibility

Keyboard Navigation

Supported

Arrow Keys

Move between events.

Enter

Open Preview.

Escape

Close Preview.

Screen Reader

Reads event type before description.

RTL

Fully supported.

Focus Indicators

Always visible.

---

# 102. Acceptance Criteria

✓ Timeline loads independently.

✓ Preview updates instantly.

✓ Search is instant.

✓ Events remain chronological.

✓ Groups are collapsible.

✓ AI Summary is user initiated.

✓ Timeline performs smoothly with large datasets.

✓ Layout matches approved design.

---

# End of Chapter 6

-------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 7 — Activities Workspace
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 103. Purpose

The Activities Workspace is the execution center of the Contact Workspace.

Unlike the Timeline, which records what has happened, the Activities Workspace focuses on what needs to happen next.

Every sales action should be planned, tracked and completed from this workspace.

It answers one business question:

> "What work is planned for this customer?"

---

# 104. Business Objectives

The Activities Workspace must allow users to:

• Schedule follow-ups

• Create tasks

• Record meetings

• Plan calls

• Add notes

• Set reminders

• Complete activities

• Reassign activities

• Monitor overdue work

Users should never leave this workspace to manage customer activities.

---

# 105. Screen Layout

Desktop

```
+--------------------------------------------------------------------------------------+
| Activities Toolbar                                                                   |
+--------------------------------------------------------------------------------------+

| Upcoming Activities                     | Activity Details                           |
|                                         |                                            |
|-----------------------------------------|--------------------------------------------|
| Today's Schedule                        |                                            |
|-----------------------------------------|--------------------------------------------|
| Completed Activities                    |                                            |
+--------------------------------------------------------------------------------------+
```

Layout Ratio

Activity List

65%

Details Panel

35%

---

# 106. Activities Toolbar

Toolbar remains sticky.

Contains

• Search Activities

• Filter

• Sort

• Date Range

• Create Activity

• Calendar View

• Refresh

Toolbar Height

56px

---

# 107. Activity Types

Supported activity types

• Task

• Phone Call

• WhatsApp Follow-up

• Email Follow-up

• Meeting

• Video Meeting

• Reminder

• Site Visit

• Internal Discussion

• Note

• Custom Activity

Every activity type has its own icon.

---

# 108. Activity Card

Each activity card displays

• Activity Icon

• Title

• Due Date

• Due Time

• Assigned User

• Priority

• Status

• Related Company

• Related Opportunity (if available)

Card Height

88–96px

Cards expand only in the Details Panel.

---

# 109. Activity Status

Supported status values

• Planned

• In Progress

• Waiting

• Completed

• Cancelled

• Overdue

Each status includes

• Color

• Icon

• Label

Status changes immediately without reloading the page.

---

# 110. Priority Levels

Priority options

• Critical

• High

• Medium

• Low

Priority is shown using

• Colored badge

• Icon

• Text label

Never rely only on color.

---

# 111. Activity Details Panel

Selecting an activity opens the Details Panel.

Displays

• Full Description

• Participants

• Related Contact

• Related Company

• Due Date

• Reminder Settings

• Attachments

• Internal Notes

• Activity History

• AI Suggestions (optional)

Panel updates instantly.

---

# 112. Quick Actions

Each activity supports

• Mark Complete

• Edit

• Duplicate

• Reschedule

• Assign

• Add Note

• Start Call

• Send Email

• Open Contact

• Delete (Permission Based)

Only actions relevant to the activity type are displayed.

---

# 113. Calendar Integration

Users may switch between

• List View

• Day View

• Week View

• Month View

Calendar reflects only activities visible to the current user based on permissions.

---

# 114. Smart Reminders

The system generates reminders for

• Upcoming Activities

• Overdue Activities

• Meetings starting soon

• Follow-ups due today

These reminders are deterministic.

No AI is required.

---

# 115. AI Suggestions

AI is optional.

Collapsed by default.

Available on demand.

Suggested capabilities

• Draft follow-up email

• Suggest meeting agenda

• Summarize previous activities

• Recommend next action

AI suggestions never modify CRM data automatically.

---

# 116. Search & Filters

Search supports

• Activity Title

• Description

• Assigned User

• Contact

• Company

• Notes

Filters

• Type

• Status

• Priority

• Owner

• Date

• Overdue

Multiple filters may be active simultaneously.

---

# 117. Empty State

Illustration

Headline

"No activities scheduled."

Primary Action

Create Activity

Secondary Actions

Schedule Meeting

Create Task

Add Reminder

---

# 118. Loading State

Skeleton Activity Cards

Skeleton Details Panel

Toolbar remains interactive.

Previously loaded activities remain visible until refresh completes.

---

# 119. Error State

Illustration

Message

"Unable to load activities."

Actions

Retry

Return to Overview

Errors never affect other workspaces.

---

# 120. Responsive Behaviour

Desktop

Two-column layout.

Tablet

Details Panel becomes a slide-over drawer.

Mobile

Single-column list.

Selecting an activity opens a full-screen detail view.

Toolbar filters move into a bottom sheet.

---

# 121. Performance

Requirements

• Incremental loading

• Cached filters

• Lazy Details Panel

• Virtual scrolling

• Independent updates

Target interaction latency

<150ms

---

# 122. Accessibility

Keyboard Navigation

Supported

Arrow Keys

Navigate activity list

Enter

Open activity details

Escape

Close details

Screen Reader

Reads activity type, title and due date

RTL

Fully supported

Focus indicators

Always visible

---

# 123. Acceptance Criteria

✓ Activities are displayed chronologically.

✓ Status updates instantly.

✓ Calendar and List views remain synchronized.

✓ Search and filters respond immediately.

✓ Details Panel updates without page reload.

✓ AI suggestions remain optional.

✓ Responsive behaviour matches specification.

✓ Workspace matches the approved design language.

---

# End of Chapter 7

-----------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 8 — Documents Workspace
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 124. Purpose

The Documents Workspace is the central repository for every file associated
with the contact.

Unlike the Timeline, which records document events, or the Overview,
which summarizes document readiness, the Documents Workspace provides
complete document management.

It answers one business question:

> "Do I have every document required to work with this customer?"

---

# 125. Business Objectives

The Documents Workspace must allow users to:

• View all documents

• Upload files

• Preview files

• Download files

• Organize documents

• Search documents

• Filter by category

• View document history

• View document versions

• Share documents

• Replace documents

• Archive documents

---

# 126. Screen Layout

Desktop

```
+--------------------------------------------------------------------------------------+
| Documents Toolbar                                                                    |
+--------------------------------------------------------------------------------------+

| Document List                               | Document Preview                        |
|                                             |                                         |
|                                             | Metadata                                |
|                                             | Version History                         |
|                                             | Related Records                         |
|                                             | Quick Actions                           |
|                                             |                                         |
+--------------------------------------------------------------------------------------+
```

Layout Ratio

Document List

65%

Preview Panel

35%

The Preview Panel remains visible while browsing.

---

# 127. Documents Toolbar

Toolbar remains sticky.

Contains

• Search

• Category Filter

• File Type Filter

• Date Filter

• Owner Filter

• Upload Document

• Export

• Refresh

Toolbar Height

56px

---

# 128. Supported Document Categories

The system supports

• Business Card

• Proposal

• Quotation

• Contract

• Purchase Order

• Invoice

• Presentation

• Meeting Minutes

• Technical Document

• Brochure

• Image

• Video

• Audio

• Email Attachment

• Other

The architecture must allow new categories without redesign.

---

# 129. Supported File Types

Examples

PDF

DOCX

XLSX

PPTX

TXT

CSV

PNG

JPG

WEBP

SVG

MP4

MOV

ZIP

Unsupported files must display a generic icon.

---

# 130. Document Card

Each document displays

• File Icon

• File Name

• Category

• File Size

• Uploaded By

• Upload Date

• Version Number

• Status

Card Height

80–90px

Cards expand only in the Preview Panel.

---

# 131. Document Preview Panel

Selecting a document updates the Preview Panel instantly.

Displays

• Large Preview

• File Information

• Category

• Version History

• Related Contact

• Related Company

• Related Opportunity

• Tags

• Comments

• Audit Information

Preview loads asynchronously.

---

# 132. Quick Actions

Available actions

• Open

• Preview

• Download

• Replace

• Upload New Version

• Rename

• Move

• Share

• Copy Link

• Archive

• Delete (Permission Based)

Unavailable actions remain hidden.

---

# 133. Version Management

The system maintains document history.

Displays

Version Number

Uploaded By

Upload Date

Change Notes

Users can compare versions.

Users can restore previous versions.

Previous versions are never permanently overwritten.

---

# 134. Search

Search Scope

• File Name

• Category

• OCR Text (where available)

• Tags

• Description

• Uploaded By

Search updates instantly.

No page reload.

---

# 135. Filters

Supported filters

• Category

• File Type

• Owner

• Upload Date

• Version

• Shared

• Archived

Multiple filters may be active simultaneously.

---

# 136. AI Document Intelligence

AI is optional.

Generated only when requested.

Available features

• Summarize Document

• Extract Key Points

• Identify Action Items

• Generate Follow-up

• Detect Missing Information

AI processing never occurs automatically.

This minimizes AI usage and cost.

---

# 137. Empty State

Illustration

Headline

"No documents available."

Primary Action

Upload Document

Secondary Actions

Scan Business Card

Import Files

Create Proposal

---

# 138. Loading State

Skeleton Document Cards

Skeleton Preview

Toolbar remains interactive.

Previously loaded documents remain visible until refresh completes.

---

# 139. Error State

Illustration

Message

"Unable to load documents."

Actions

Retry

Return to Overview

Errors never affect other workspaces.

---

# 140. Responsive Behaviour

Desktop

Two-column layout.

Tablet

Preview becomes slide-over drawer.

Mobile

Single-column document list.

Selecting a document opens a full-screen preview.

Toolbar filters move into a bottom sheet.

---

# 141. Performance

Requirements

• Incremental loading

• Virtual scrolling

• Lazy preview loading

• Cached filters

• Independent refresh

• Background thumbnail generation

Target interaction latency

<150ms

---

# 142. Accessibility

Keyboard Navigation

Supported

Arrow Keys

Navigate document list

Enter

Open Preview

Escape

Close Preview

Screen Reader

Reads file name, category and upload date

RTL

Fully supported

Focus indicators

Always visible

---

# 143. Security

Document permissions follow role-based access control.

Restricted files are hidden.

Download permissions are validated before execution.

Audit logs record

• Upload

• Download

• Replace

• Delete

• Restore

• Share

---

# 144. Acceptance Criteria

✓ Documents load independently.

✓ Preview updates instantly.

✓ Version history is always available.

✓ Search responds immediately.

✓ AI analysis is user initiated only.

✓ Responsive behaviour matches specification.

✓ Permissions are enforced correctly.

✓ Workspace matches the approved design.

---

# End of Chapter 8

------------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 9 — Interactions Workspace
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 145. Purpose

The Interactions Workspace is the complete communication center for a contact.

Unlike the Timeline, which records every business event, the Interactions
Workspace focuses only on conversations between your organization and the
customer.

It answers one business question:

> "How are we communicating with this customer?"

Every communication channel should be visible from a single workspace.

---

# 146. Business Objectives

The Interactions Workspace enables users to:

• View communication history

• Start new conversations

• Track response times

• Monitor customer engagement

• Review conversation outcomes

• Continue previous conversations

• Share communication records

• Search conversations

• Filter by communication channel

Users should never need to switch between multiple CRM pages to understand
customer communication.

---

# 147. Screen Layout

Desktop

```
+--------------------------------------------------------------------------------------+
| Communication Toolbar                                                                |
+--------------------------------------------------------------------------------------+

| Conversation List                          | Conversation Details                     |
|                                            |                                          |
|--------------------------------------------|------------------------------------------|
| Conversation Timeline                      | Contact Information                      |
|                                            | Related Activities                       |
|                                            | Related Documents                        |
|                                            | AI Conversation Summary                  |
+--------------------------------------------------------------------------------------+
```

Layout Ratio

Conversation List

35%

Conversation Details

65%

The Details Panel remains visible while selecting conversations.

---

# 148. Communication Toolbar

Toolbar remains sticky.

Contains

• Search Conversations

• Channel Filter

• Date Filter

• User Filter

• New Interaction

• Export

• Refresh

Toolbar Height

56px

---

# 149. Supported Communication Channels

The workspace supports

• Phone Call

• Email

• WhatsApp

• SMS

• LinkedIn

• Microsoft Teams

• Zoom Meeting

• Google Meet

• In-Person Meeting

• Internal Note

• Customer Reply

• Voice Recording

• Video Recording

The architecture must allow future communication channels.

---

# 150. Conversation List

Each conversation displays

• Channel Icon

• Contact Name

• Conversation Subject

• Last Message Preview

• Date

• Time

• Direction

• Status

• Assigned User

Maximum Preview Length

Two lines

Cards remain compact.

---

# 151. Conversation Details

Selecting a conversation displays

• Full Conversation

• Participants

• Attachments

• Related Activities

• Related Opportunities

• Related Documents

• Conversation Notes

• Conversation Timeline

• Communication Statistics

The Details Panel updates instantly.

---

# 152. Direction Indicator

Each communication is classified as

• Incoming

• Outgoing

Direction appears using

• Arrow Icon

• Label

• Color

Direction must never rely only on color.

---

# 153. Communication Status

Supported status values

• Sent

• Delivered

• Read

• Replied

• Missed

• Failed

• Cancelled

Status updates automatically when supported by the communication provider.

---

# 154. Quick Actions

Available actions

• Call Back

• Reply

• Reply All

• Forward

• WhatsApp

• Email

• Schedule Follow-up

• Create Activity

• Add Note

• Share Conversation

• Download Attachment

• Delete (Permission Based)

Unavailable actions remain hidden.

---

# 155. Communication Statistics

Display

• Total Calls

• Total Emails

• Total WhatsApp Messages

• Total Meetings

• Average Response Time

• Last Response

• Customer Response Rate

These values are calculated automatically.

No AI required.

---

# 156. Search

Search Scope

• Subject

• Message Content

• Contact Name

• Company

• Notes

• Attachments

• User

Results update instantly.

No page reload.

---

# 157. Filters

Supported filters

• Channel

• Direction

• Status

• User

• Date

• Attachments

• Replied

• Unanswered

Multiple filters may be active simultaneously.

---

# 158. AI Conversation Assistant

AI features remain optional.

Generated only when requested.

Available capabilities

• Summarize Conversation

• Draft Reply

• Extract Action Items

• Detect Customer Sentiment

• Recommend Next Step

• Generate Follow-up Email

The system must never generate AI content automatically.

AI usage begins only after explicit user interaction.

---

# 159. Empty State

Illustration

Headline

"No communication history found."

Primary Action

Start Interaction

Secondary Actions

Call Contact

Send Email

Send WhatsApp

---

# 160. Loading State

Skeleton Conversation Cards

Skeleton Details Panel

Toolbar remains interactive.

Previously loaded conversations remain visible until refresh completes.

---

# 161. Error State

Illustration

Message

"Unable to load conversations."

Actions

Retry

Return to Overview

Errors never affect other workspaces.

---

# 162. Responsive Behaviour

Desktop

Split View

Conversation List

Conversation Details

Tablet

Conversation Details opens as slide-over drawer.

Mobile

Single-column list.

Selecting a conversation opens a full-screen conversation view.

Toolbar filters move into a bottom sheet.

---

# 163. Performance

Requirements

• Incremental loading

• Infinite scrolling

• Cached conversations

• Lazy attachment loading

• Independent refresh

Target interaction latency

<150ms

---

# 164. Accessibility

Keyboard Navigation

Supported

Arrow Keys

Navigate conversation list

Enter

Open conversation

Escape

Close conversation

Screen Reader

Reads communication channel, sender and timestamp

RTL

Fully supported

Focus indicators

Always visible

---

# 165. Security

Communication records follow role-based permissions.

Restricted conversations remain hidden.

Sensitive attachments require permission before opening.

Audit logs record

• Open

• Reply

• Forward

• Share

• Download

• Delete

---

# 166. Acceptance Criteria

✓ Conversations load independently.

✓ Details update instantly.

✓ Search responds immediately.

✓ Filters remain responsive.

✓ Communication statistics calculate correctly.

✓ AI assistance is user initiated only.

✓ Permissions are enforced.

✓ Responsive behaviour matches specification.

✓ Workspace matches the approved design.

---

# End of Chapter 9

---------

# ============================================================================
# Lead Capture Pro
# Contact Workspace v1.0
# Chapter 10 — AI Workspace
# Status: Approved
# Version: 1.0
# ============================================================================

---

# 167. Purpose

The AI Workspace is the intelligent assistant for the Contact Workspace.

Unlike general-purpose AI chat applications, the AI Workspace is a
context-aware Sales Copilot.

It always understands the currently opened contact and assists users in
making better sales decisions.

The AI Workspace answers one business question:

> "What should I do next with this customer?"

AI should reduce effort, improve decision making and increase sales
productivity.

It must never replace the CRM.

The CRM remains the source of truth.

---

# 168. Core Design Principles

The AI Workspace follows these principles.

• Context before conversation

• Suggestions before generation

• One-click execution

• Explain recommendations

• Never fabricate CRM data

• Minimize AI cost

• User remains in control

AI is an assistant.

Never an autonomous operator.

---

# 169. Screen Layout

Desktop

```
+--------------------------------------------------------------------------------------+
| AI Toolbar                                                                           |
+--------------------------------------------------------------------------------------+

| AI Actions                      | AI Conversation & Insights                         |
|                                 |                                                    |
|---------------------------------|----------------------------------------------------|
| Suggested Actions               | Generated Results                                  |
|                                 |                                                    |
|---------------------------------|----------------------------------------------------|
| CRM Context                     | Previous AI Sessions                               |
+--------------------------------------------------------------------------------------+
```

Layout Ratio

Left Panel

35%

Right Panel

65%

---

# 170. AI Toolbar

Contains

• Ask AI

• Suggested Prompts

• Generate

• Clear Session

• Export

• AI Usage

Toolbar remains sticky.

Height

56px

---

# 171. CRM Context

The AI automatically receives

Current Contact

Current Company

Timeline

Activities

Documents

Interaction History

Relationship Health

Current Opportunity

Current Pipeline Stage

Recent Notes

Upcoming Follow-ups

The user never manually uploads CRM information.

Context is automatic.

---

# 172. Suggested Actions

Instead of asking users to type prompts,
the AI Workspace provides predefined actions.

Examples

• Summarize Contact

• Prepare Meeting

• Draft Follow-up Email

• Generate WhatsApp Message

• Analyze Relationship

• Identify Risks

• Recommend Next Action

• Generate Proposal Summary

• Review Customer History

• Prepare Call Notes

Suggested Actions appear as cards.

Single click.

---

# 173. AI Conversation

The AI Conversation panel displays

User Prompt

AI Response

Referenced CRM Data

Suggested Next Actions

Timestamp

Feedback

Conversation history remains associated with the contact.

---

# 174. AI Output Types

The AI can generate

• Executive Summary

• Meeting Brief

• Sales Strategy

• Follow-up Email

• WhatsApp Draft

• Call Preparation

• Objection Handling

• Proposal Summary

• Opportunity Analysis

• Risk Assessment

• Customer Sentiment

• Next Best Action

The AI must clearly label every generated output.

---

# 175. AI Confidence

Every AI response displays

Confidence Level

High

Medium

Low

Confidence explains the quality of the recommendation.

Low-confidence responses encourage user review.

---

# 176. AI References

Every AI response lists

Referenced Timeline Events

Referenced Activities

Referenced Documents

Referenced Notes

Referenced Opportunities

Users can open referenced records directly.

AI recommendations are fully traceable.

---

# 177. AI Cost Optimization

The system minimizes AI usage.

The following are deterministic:

• Relationship Health

• Response Time

• Activity Counts

• Timeline Statistics

• Document Counts

• Engagement Metrics

AI is used only for

Reasoning

Writing

Summarization

Recommendation

No AI calls are made for simple calculations.

---

# 178. AI Session Management

Each contact has its own AI session.

Sessions display

Title

Created Date

Last Updated

Message Count

Users may

Rename

Archive

Delete

Export

Sessions remain linked to the contact.

---

# 179. AI Safety

The AI must

Never fabricate CRM records.

Never modify CRM data automatically.

Never delete records.

Never create activities without user confirmation.

Never send communications automatically.

Every action requires explicit approval.

---

# 180. Smart Recommendations

Without user prompting, the AI Workspace may display passive insight cards.

Examples

"Follow-up overdue by 7 days."

"Customer opened your proposal twice."

"Meeting preparation recommended."

These cards use deterministic rules.

No AI call is required.

Selecting a card triggers AI only if additional reasoning is needed.

---

# 181. Prompt Library

The system includes categorized prompt templates.

Categories

• Sales

• Meetings

• Communication

• Documents

• Negotiation

• Opportunity

• Executive Summary

Users may also save custom prompts.

---

# 182. Search

Search AI sessions by

• Prompt

• Response

• Category

• Date

• Contact

Results update instantly.

---

# 183. Empty State

Illustration

Headline

"Ask AI about this customer."

Suggested Cards

Summarize Contact

Prepare Meeting

Generate Email

Analyze Relationship

No empty chat window should appear.

---

# 184. Loading State

Display

AI Thinking Indicator

Streaming Response

Progress Status

CRM Context remains visible.

Users may cancel generation.

---

# 185. Error State

Message

"AI could not generate a response."

Actions

Retry

Edit Prompt

View Context

Errors never affect CRM functionality.

---

# 186. Responsive Behaviour

Desktop

Split View

Left Actions

Right Conversation

Tablet

Actions collapse into drawer.

Mobile

Conversation occupies full screen.

Suggested Actions become horizontal cards.

---

# 187. Performance

Requirements

Lazy load previous sessions.

Stream AI responses.

Cache CRM context.

Reuse deterministic calculations.

Never reload the workspace.

Target

Initial AI workspace load

<250ms

---

# 188. Accessibility

Keyboard Navigation

Supported

Screen Reader

Supported

Focus Indicators

Visible

RTL

Fully supported

Touch Targets

Minimum 44px

Streaming responses announced correctly.

---

# 189. Acceptance Criteria

✓ AI always understands the current contact.

✓ CRM context loads automatically.

✓ Suggested Actions require one click.

✓ AI never performs actions without approval.

✓ Deterministic calculations do not consume AI.

✓ AI responses reference CRM data.

✓ AI cost optimization rules are respected.

✓ AI Workspace matches the approved design language.

---

# End of Chapter 10