---
name: Mercury
description: Dense, high-contrast design system extracted from mercury.com.
version: alpha
colors:
  void: "#0A0A0F"
  chalk: "#FFFFFF"
  signal: "#3B5BFE"
  graphite: "#6C6C7B"
  wash: "#F4F4F6"
typography:
  display:
    fontFamily: "SF Pro Display, system-ui, sans-serif"
    fontSize: "64px"
    fontWeight: 700
    lineHeight: 1.0
  headline-lg:
    fontFamily: "SF Pro Display, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 700
    lineHeight: 1.1
  headline-md:
    fontFamily: "SF Pro Display, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.2
  body-md:
    fontFamily: "SF Pro Text, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label-sm:
    fontFamily: "SF Pro Text, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "40px"
  3xl: "64px"
rounded:
  sm: "4px"
  md: "8px"
  lg: "16px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.chalk}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.void}"
    textColor: "{colors.chalk}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
    height: "40px"
  card:
    backgroundColor: "{colors.chalk}"
    textColor: "{colors.void}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

## Overview

A dense, high-contrast interface built for efficiency. Large type and bold color blocking create a clear hierarchy, while tight spacing keeps information scannable.

## Colors

- **`void` (#0A0A0F)**　Primary surfaces and text on light backgrounds. Almost all readable content sits on or against this color.
- **`chalk` (#FFFFFF)**　Background for cards, modals, and any surface that needs to lift above void.
- **`signal` (#3B5BFE)**　Interactive accent reserved for primary actions and active states.
- **`graphite` (#6C6C7B)**　Tertiary text and disabled states. Used when content should recede.
- **`wash` (#F4F4F6)**　Subtle section backgrounds, less aggressive than chalk for grouping.

## Typography

- **`display`**　64px / weight 700 / line-height 1.0　Marketing-grade headlines.
- **`headline-lg`**　40px / weight 700 / line-height 1.1　Page titles.
- **`headline-md`**　28px / weight 700 / line-height 1.2　Section headers.
- **`body-md`**　16px / weight 400 / line-height 1.5　Body copy and form content.
- **`label-sm`**　13px / weight 600 / line-height 1.3　Buttons, badges, and tab labels.

## Components

### `button-primary`

Filled with signal, chalk text, rounded 8px, padding 12px 20px, height 40px. The default choice for the main action in any workflow.

### `button-secondary`

Filled with void, chalk text, rounded 8px, padding 12px 20px, height 40px. Used for secondary actions that still need strong visibility on light backgrounds.

### `card`

Chalk surface with 16px radius and padding 24px. Creates elevation through background contrast alone, no shadows.

## Do's and Don'ts

- Don't use signal for static text.
- Don't set body copy on void without strong surrounding whitespace.
- Don't mix more than one display typeface in a single view.
- Don't place a chalk card directly on a chalk background.
