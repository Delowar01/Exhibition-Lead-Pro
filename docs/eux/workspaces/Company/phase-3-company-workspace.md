# ============================================================================
# Lead Capture Pro
# Phase 3 – Company Workspace
# Enterprise UX Implementation Plan
# Version: 1.0
# Status: Approved
# ============================================================================

---

# Objective

Implement the Company Workspace exactly as shown in the approved Company Workspace UI.

Replace the existing Company Detail screen while preserving all existing business functionality.

Use existing backend APIs.

If functionality does not have a backend implementation, hide it instead of creating mock functionality.

The Company Workspace is the 360° account management center for customer organizations.

It must provide complete visibility into the customer relationship, key contacts, opportunities, projects, engagement, revenue and company health.

---

# CRITICAL

This is a UX implementation only.

Do NOT modify

• Database schema

• Existing APIs

• Authentication

• Permissions

• OCR

• AI Services

• Business Logic

Only improve the user interface.

---

# Existing APIs

Reuse all existing Company APIs.

Build on current

• Company CRUD

• Contacts

• Leads

• Activities

• Documents

• Communications

• AI

• Reports

• Notes

• Timeline

Reuse existing components whenever possible.

---

# Hide (No Backend)

If these features do not exist, hide them.

Do NOT fabricate.

Examples

• Revenue Forecast

• Customer Satisfaction Score

• Renewal Prediction

• Opportunity Win Probability

• AI Revenue Forecast

• Contract Renewal Automation

---

# Design Rules

Implement the approved UI exactly.

Do NOT redesign.

Do NOT move cards.

Do NOT change spacing.

Reuse existing components.

Use existing design tokens.

No hardcoded colors.

No duplicate components.

---

# T001

Company Hero + Workspace Shell

Implement

Company Hero

Workspace Tabs

Page Layout

Sticky Header

Sticky Tabs

Persistent Right Sidebar

Company Hero displays

• Company Logo

• Company Name

• Status

• Industry

• Website

• Phone

• Email

• Owner

• Customer Since

• Company Size

• Location

Primary Actions

• Add Contact

• Add Activity

• Email

• Call

• More

Hero remains visible while switching tabs.

---

# T002

Overview Workspace

Implement

Company Summary

Company Information

Engagement Overview

Top Opportunities

Top Open Leads

Recent Documents

Company Timeline

Cards remain in the exact order shown.

---

# T003

Workspace Tabs

Implement

Overview

Contacts

Leads

Opportunities

Projects

Activities

Documents

Interactions

AI Workspace

Notes

Settings

Workspace switching

• Lazy loaded

• Cached

• No page reload

• Cross-fade animation

---

# T004

Right Sidebar

Implement

Account Health Score

Health Factors

Key Contacts

Recent Activities

Sidebar remains persistent.

Do not rerender while switching tabs.

---

# T005

Company Health

Display

Overall Health Score

Health Factors

• Engagement

• Relationship

• Activity

• Satisfaction

• Risk

Health calculations should use deterministic backend data whenever available.

Do not generate AI scores.

---

# T006

Engagement Overview

Implement

Interactive Line Chart

Periods

7 Days

30 Days

90 Days

1 Year

Chart updates instantly.

No page refresh.

---

# T007

Top Opportunities

Display

Opportunity Name

Value

Stage

Quick Open

View All

Reuse existing Opportunity components.

---

# T008

Top Open Leads

Display

Lead

Lead Score

Status

Owner

Quick Open

View All

Reuse existing Lead components.

---

# T009

Recent Documents

Display

File

Type

Date

Size

Quick Download

View All

Reuse existing Documents module.

---

# T010

Company Timeline

Display

Major milestones

Examples

• Company Created

• First Contact

• First Meeting

• First Opportunity

• Customer

• Renewal

Timeline should be horizontally scrollable on smaller screens.

---

# T011

Key Contacts

Display

Avatar

Name

Position

Quick Email

Quick Call

View All

Selecting a contact opens Contact Workspace.

---

# T012

Recent Activities

Display

Activity

Date

Owner

Status

View All

Reuse existing Activities module.

---

# T013

AI Workspace

Reuse existing AI infrastructure.

Provide

• Company Summary

• Account Analysis

• Opportunity Analysis

• Meeting Preparation

• Executive Summary

• Email Draft

• Next Best Action

AI remains user initiated.

Never automatic.

---

# T014

Responsive Behaviour

Desktop

Two-column layout

Tablet

Sidebar collapses

Mobile

Single-column layout

Sidebar becomes bottom sheet

Tabs become horizontally scrollable

---

# T015

Accessibility

WCAG AA

Keyboard Navigation

RTL

Visible Focus States

Screen Reader Support

Touch Targets ≥44px

---

# T016

Performance

Target

Workspace switching

<150ms

Do not rerender

• Header

• Navigation

• Hero

• Sidebar

Cache

Tabs

Charts

Company Summary

Lazy load inactive workspaces.

---

# T017

Validation

Run

TypeScript validation

Verify

No console errors

No API regressions

Responsive

RTL

Accessibility

Navigation

Existing functionality

---

# Final Report

Provide

1. Components Created

2. Components Reused

3. Files Modified

4. Performance Improvements

5. Accessibility Improvements

6. Known Limitations

7. Desktop Screenshot

8. Tablet Screenshot

9. Mobile Screenshot

10. Any assumptions made

---

# Success Criteria

✓ UI matches approved Company Workspace image.

✓ Existing functionality preserved.

✓ No backend changes.

✓ No API changes.

✓ Responsive implementation.

✓ Sidebar remains persistent.

✓ AI remains user initiated.

✓ No TypeScript errors.

✓ No console errors.

✓ No performance regression.