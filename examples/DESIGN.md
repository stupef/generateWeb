---
name: Cursor
description: Warm paper-like design system extracted from cursor.com.
version: alpha
colors:
  parchment: "#F5F1E8"
  ink: "#2A2A2A"
  ember: "#E86A33"
  mist: "#E8E4DB"
typography:
  headline-lg:
    fontFamily: "Inter, sans-serif"
    fontSize: "48px"
    fontWeight: 600
    lineHeight: 1.1
  headline-md:
    fontFamily: "Inter, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.2
  body-lg:
    fontFamily: "Inter, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: "Inter, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  label-sm:
    fontFamily: "Inter, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "48px"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  full: "9999px"
components:
  button-primary:
    backgroundColor: "{colors.ember}"
    textColor: "#FFFFFF"
    typography: "{typography.label-sm}"
    rounded: "{rounded.md}"
    padding: "14px 24px"
    height: "44px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
    height: "40px"
  card:
    backgroundColor: "{colors.parchment}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

## Overview

A calm, text-forward interface that relies on generous whitespace and a warm neutral palette to keep focus on content. Visual weight sits on the page headline and the single primary action.

## Colors

- **`parchment` (#F5F1E8)**　Page background. Intentionally warm to soften long reading sessions and make ink feel printed rather than digital.
- **`ink` (#2A2A2A)**　Primary text and strong UI lines. Carries almost all reading content.
- **`ember` (#E86A33)**　Accent color reserved for the single most important action on any screen.
- **`mist` (#E8E4DB)**　Subtle surfaces and dividers used to group related content without competing for attention.

## Typography

- **`headline-lg`**　48px / weight 600 / line-height 1.1　Top-of-page headlines.
- **`headline-md`**　36px / weight 600 / line-height 1.2　Section headlines.
- **`body-lg`**　18px / weight 400 / line-height 1.6　Introductory paragraphs.
- **`body-md`**　16px / weight 400 / line-height 1.6　Default reading text.
- **`label-sm`**　13px / weight 500 / line-height 1.4　Buttons, labels, and compact UI text.

## Components

### `button-primary`

Filled with ember, white text, rounded 8px, padding 14px 24px, height 44px. Use it for the single decisive action on a page.

### `button-secondary`

Transparent background with ink text, rounded 8px, padding 12px 20px, height 40px. Holds secondary actions that should not compete with the primary button.

### `card`

Parchment surface with a 1px mist border, 12px radius, padding 24px. Keeps related content grouped without adding visual noise.

## Do's and Don'ts

- Don't use ember for decorative elements.
- Don't set text on parchment darker than ink.
- Don't introduce a second font family.
- Don't nest cards inside cards with the same parchment background.
