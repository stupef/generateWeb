---
name: page-sample-to-design-md
description: Convert a browser-collected PageSample JSON object into a concise, AI-ready Google-format DESIGN.md using observed styles from one rendered page. Use when a plugin sends computed-style evidence for DESIGN.md generation.
---

# PageSample to DESIGN.md

## Purpose

Turn one page's collected, rendered style data into a `DESIGN.md` that helps a coding model reproduce that page's visual language. The input is evidence from the page, not a complete source design system. Describe observed patterns and practical usage rules without inventing styles, components, or interaction states.

This skill only interprets the supplied `PageSample` and returns one complete `DESIGN.md`. It does not inspect or interact with a browser, collect more data, call a model, or run the official linter. The current input has no interaction-state observations; do not claim that menus, dialogs, hover, focus, or other post-interaction states were inspected.

## Input contract

The input is one complete JSON object produced by the browser plugin's `PageSample` collector. It describes one URL at one viewport and contains page metadata plus zero or more of these data channels: `elements`, `typography`, `boxes`, and `styles`. It may also contain canvas, font, background, embedded-content, and collection-statistics fields. Treat the actual supplied JSON as authoritative; do not assume optional records or fields exist just because they appear in examples.

Use `ref` to join records across channels. The same `ref` identifies the same DOM element in `elements`, `typography`, `boxes`, and `styles`. A channel may omit a `ref` by design because its sampling threshold excluded that element. Do not interpret the omission as zero, a contradiction, or evidence that the ref system differs.

### PageSample value semantics

- `null` means not applicable or not resolvable to the represented numeric value. It does not mean the collector failed to sample the field.
- `styles[].shadow: null` means no shadow was observed on that sampled component. `elements[].backgroundColor: null` means that element itself is transparent / has no surface. It is not a missing color sample. Use canvas fields separately for the composed page canvas.
- `letterSpacing: null` means CSS `normal`, not missing data and not literal `0px`.
- `maxWidth: null` means the collector could not represent max-width as an integer pixel value (for example, percentage or `none`). Do not invent a numeric maximum width or claim a specific max-width value was observed.
- `0` means the field exists and its measured value is zero, except `fontSize: 0`, which is a parse-failure sentinel. For `fontSize: 0`, use the same element's `typography` record if present; otherwise omit the numeric font size and do not emit `0px`.
- All dimensions are CSS pixels unless stated otherwise. `area` is square pixels. `fontWeight` is a unitless normalized integer. `radius` percentages are already converted to pixels.
- `textChars` gives text length, not text content. Do not guess button labels, page copy, business purpose, or brand meaning from character counts.

## Read and synthesize the sample

Use the most specific evidence available:

- `elements` is the broadest recorded-element channel and includes tags, text length, rendered area, surface/control flags, and basic colors/borders.
- `typography` contains text-bearing elements with font family, size, weight, line height, and letter spacing.
- `boxes` contains qualifying layout boxes with spacing and geometry details.
- `styles` contains recognized components with detailed visual properties.

Prefer `styles` for a component's appearance, joined `typography` for its text styles, and `boxes` for its layout. Use `elements` and canvas fields to understand page-wide color use. When observations conflict, do not average them; use the most specific record, and describe meaningful uncertainty.

Organize the evidence into colors, typography, layout and spacing, elevation and shapes, and components. Assign roles from usage patterns, tag, `kind`, `inNav`, `isControl`, `definesSurface`, `looksLikeCard`, heading level, and repeated styles. Use neutral names when the semantic role is uncertain. Do not call a color a brand, status, success, or error color without evidence.

Preserve all raw values exactly. Do not invent, normalize, or silently round token values. Repeated and near-identical observations may be grouped only when the raw values remain available and the grouping is explained. Do not create a token just to complete a conventional scale.

Useful derived statistics are allowed when they can be recalculated deterministically from the supplied sample and are labeled as calculated. Examples include occurrence counts, shares with an explicit denominator, typography size ratios relative to an observed body size, and WCAG contrast ratios calculated from observed foreground/background colors. Do not sum nested parent and child rectangles as if their areas were disjoint. Do not infer responsive breakpoints from one viewport. A spacing base may be described as a candidate pattern only when derived from observed spacing values; state its coverage and outliers. Never create a new token value solely to fill a scale.

Use `visited`, `skipped`, `truncated`, `elapsedMs`, and `embedded` as collection context, not design tokens. If `truncated` is true or substantial content was skipped, note the sampling limitation where useful and avoid claiming the results represent the complete site.

## Content requirements

Write an evidence-rich document that a coding agent can act on. Do not merely list CSS properties. Explain why a token role is assigned, where it appears, how to use it when recreating the page, and what choices to avoid.

- **Colors:** identify page/canvas background, surfaces, primary and secondary text, borders, and prominent control/accent colors where supported. Explain distinct close colors when they serve different observed roles. Counts and contrast ratios may be included when reliably calculated; state the denominator or color pair.
- **Typography:** state the observed body baseline when supported. Describe each hierarchy tier with exact size, weight, line height, letter spacing, and associated tag/heading evidence. Explain which roles the observed font families serve. If suggesting fallback fonts, label them as recommendations rather than observed facts; do not claim an untested fallback was used.
- **Layout:** describe measured content widths, repeated spacing values, box padding, margins, and gaps. A repeated width may be described as a content width, but distinguish it from an explicit CSS `max-width`. Explain a candidate spacing base and outliers only when the data supports it. Do not infer responsive behavior from one viewport.
- **Elevation and depth:** describe shadows and borders. If sampled component records have `shadow: null`, say those sampled components use no shadow. Do not generalize to the entire page when no relevant records were sampled.
- **Shapes:** preserve distinct radii for buttons, inputs, cards, and other observed kinds. Include counts when reliable.
- **Components:** describe only kinds represented in `styles` (such as buttons, inputs, cards, or navigation). Include observed colors, radius, border, padding, size, and typography. Distinguish variants only when sampled properties support the distinction. State sample counts where useful. Do not invent hover, disabled, or other interaction states.
- **Do's and Don'ts:** translate repeated evidence into concise implementation rules. Label practical recommendations as recommendations, not directly measured facts.

Do not guess page copy, user demographics, business strategy, brand personality, or intended accessibility compliance. You may describe a visual impression (for example, high-density or restrained contrast) only when concrete observations support it. Avoid generic filler such as “modern” or “clean” without specific design implications.

## Output format

Return only the complete `DESIGN.md` content. Do not return JSON, a preamble, an explanation outside the document, a status message, or an enclosing Markdown code fence.

Follow this content structure, modeled on the provided `DESIGN (2).md`. Include only sections supported by the input, while preserving their order:

```markdown
---
name: "[page hostname or concise page name]"
description: "[source URL and sampled viewport width; extraction date only if supplied]"
version: "alpha"
colors:
  neutral: "[observed page canvas or main neutral]"
  primary: "[exact observed color with the strongest supported primary role]"
  secondary: "[observed secondary role, if supported]"
  tertiary: "[observed accent or action role, if supported]"
  surface: "[observed surface role, if supported]"
typography:
  body-md:
    fontFamily: "[observed family stack]"
    fontSize: "[observed px value]"
    fontWeight: [observed integer]
    lineHeight: "[observed value, px or unitless ratio]"
spacing:
  xs: "[observed px value]"
rounded:
  sm: "[observed px value]"
components:
  button-primary:
    backgroundColor: "[observed color or transparent]"
    textColor: "[observed color]"
    rounded: "[observed dimension or matching token reference]"
    padding: "[observed padding value]"
---

## Overview
[Concrete visual summary.] 

**采样口径**

[Source URL, sampled viewport width, and scope/limitations supported by input.]

## Colors
[Role-based palette analysis with evidence and practical use rules.]

## Typography
[Observed hierarchy, font roles, and implementation guidance.]

## Layout
[Observed widths and spacing pattern with any evidence-based base/outliers.]

## Elevation & Depth
[Observed shadows and borders, or explicit no-shadow finding for sampled components.]

## Shapes
[Observed radius tiers and their component usage.]

## Components

### `button-primary`
[Observed component styles, count where useful, and implementation guidance.]

## Do's and Don'ts
- [Evidence-based implementation rule.]
```

The example is a structural guide, not output data. Replace all bracketed instructions; never emit placeholders or `...`. Omit token groups and prose sections without usable evidence. Do not copy values from this skill or from `DESIGN (2).md`.

### Google DESIGN.md and lint-oriented constraints

Construct the document to be compatible with the current Google Labs `DESIGN.md` alpha format:

- Start YAML front matter with a line containing exactly `---` and close it with another line containing exactly `---`. YAML must parse and contain a non-empty `name`.
- Use only supported token groups: `description`, `omitted`, `colors`, `typography`, `rounded`, `spacing`, and `components` (plus `name` and `version`). Do not add custom collection fields or unsupported keys such as `sources`.
- Include an observed `colors.primary` token as required by the format. If there is no usable color evidence, do not fabricate a token; return a concise input-insufficiency message instead of a false document.
- Use valid CSS colors; supported typography properties (`fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing`); and valid `px`, `em`, or `rem` dimensions. Preserve exact measurements. Use `{path.to.token}` references only when the target exists.
- Component token properties must be supported (for example, `backgroundColor`, `textColor`, `typography`, `rounded`, `padding`, `size`, `height`, `width`).
- Use canonical `##` headings in this order when present: `Overview`, `Colors`, `Typography`, `Layout`, `Elevation & Depth`, `Shapes`, `Components`, `Do's and Don'ts`. Never repeat a canonical section heading.
- Keep prose consistent with YAML and the sample. Every numeric claim must match an observed value or be clearly labeled as a deterministic calculation with its basis.
- This skill does not run lint. Never claim lint passed; only an actual official linter run can confirm that.

## Final consistency check

Before returning the document, verify that:

- The response contains only one complete Markdown `DESIGN.md`, without JSON or surrounding commentary.
- Every numeric token is an exact observed value; every derived prose statistic is transparently calculated and not misleading.
- `null`, zero, and absent-channel `ref` values follow the semantics above.
- Every component, style, and state is supported by the sample; no interaction state is claimed for the current schema.
- Roles and usage rules are grounded in evidence; unsupported intent is omitted.
- YAML parses, token groups and fields are supported, headings are ordered, and the document has no filler or contradictory values.
