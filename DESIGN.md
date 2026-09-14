---
name: Music library
description: A practical slate-and-blue studio console for local playlist backups.
colors:
  blue: "#245bcc"
  ink: "#263449"
  muted: "#58677a"
  line: "#d5dce5"
  surface: "#fff"
  workspace: "#eef1f5"
  masthead: "#253348"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(1.7rem, 2.5vw, 2.15rem)"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1.05rem"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    lineHeight: 1.5
  control:
    fontSize: "0.875rem"
    fontWeight: 600
  label:
    fontSize: "0.81rem"
    fontWeight: 600
  mono:
    fontFamily: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace'
    fontSize: "0.81rem"
rounded:
  "3": "3px"
  "4": "4px"
  "5": "5px"
spacing:
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "26": "26px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.surface}"
    typography: "{typography.control}"
    rounded: "{rounded.5}"
    padding: "12px 26px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "#35465b"
    typography: "{typography.control}"
    rounded: "{rounded.5}"
    padding: "8px 13px"
  button-header:
    backgroundColor: "transparent"
    textColor: "#f0f5ff"
    typography: "{typography.control}"
    rounded: "{rounded.5}"
    padding: "8px 13px"
  button-text:
    backgroundColor: "transparent"
    textColor: "#2156b4"
    typography: "{typography.control}"
    rounded: "{rounded.5}"
    padding: "5px 0"
  input-search:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.5}"
    padding: "10px 12px"
    width: "100%"
  badge:
    backgroundColor: "#e7ecf2"
    textColor: "#536277"
    rounded: "{rounded.4}"
    padding: "3px 7px"
  console:
    backgroundColor: "{colors.surface}"
    rounded: "6px"
---

# Design System: Music library

## Overview

**Creative North Star: "Studio console"**

A practical, compact workspace: slate framing, cool-gray surroundings and quiet white working surfaces. Restrained blue identifies action and progress; ruled records and visible state carry the interface rather than decoration.

This records the built system in `src\web\styles.css`, `src\web\index.html` and `src\web\app.ts`, informed by `PRODUCT.md`. The user-approved direction is corroborated by the HTML contract (`seed895a4aee / candidate4`). Measurements below describe this implementation, not a universal template for future surfaces.

**Key Characteristics:**
- Compact system typography with explicit hierarchy.
- Cool neutral surfaces, ruled records and restrained blue emphasis.
- Square-leaning controls and low, quiet elevation.
- Visible progress, textual outcomes and inspectable details.

## Colors

The palette is cool and slate-led, with one blue accent family and separate semantic state tints.

### Primary
- **Console blue** (`blue`): the filled primary action and progress fill. Related darker blues identify links and interactive text; blue is not exclusive to the primary button.

### Neutral
- **Slate ink** (`ink`) and **secondary slate** (`muted`): primary text versus supporting explanation and metadata.
- **Rule gray** (`line`): table, history and destination dividers.
- **Working white** (`surface`), **cool workspace** (`workspace`) and **masthead slate** (`masthead`): working plane, surrounding canvas and dark frame.

State badges use blue for running, green for complete, amber for partial/interrupted and red for failed; exact component colors remain in the sidecar snippets. Informational, success and error notices also use tinted backgrounds.

The sidecar's tonal strips are synthesized preview metadata, not additional shipped palette tokens.

**The Written State Rule.** Color accompanies a visible state label; it never replaces the outcome text.

## Typography

**Body and heading font:** the platform system stack; no downloaded display face.
**Label/Mono font:** the recorded monospace stack for filesystem paths and technical values.

The hierarchy is compact and functional, not a mathematical type scale. The frontmatter records reusable roles; local metadata sizes are not promoted into new global tokens.

### Hierarchy
- **Headline:** the fluid page heading, using the `headline` role.
- **Title:** section headings use `title`; the backup readout heading is deliberately larger (`1.2rem`, weight `600`, line-height `1.35`).
- **Body:** inherits the system stack and `body` line height. Ordinary controls, inventory cells and setup copy commonly use (`0.875rem`); paragraphs are capped at (`72ch`).
- **Labels:** compact semibold labels use `label`; supporting text commonly uses (`0.75rem` or `0.81rem`).
- **Numbers:** counts, progress labels and totals use tabular numerals; playlist item counts align right.

**The Readable Record Rule.** Keep titles and paths wrapping, supporting metadata subordinate, and numeric columns aligned.

## Layout

The header and workspace share a centered maximum width (`1480px`). Desktop workspace gutters are (`40px`); the current console splits into a flexible library (`1.8fr`) and readout (`1fr`, minimum `340px`). Interior spacing repeatedly uses the recorded spacing values, without a forced uniform spacing scale.

- At widths up to (`1050px`), outer gutters become (`24px`), common panel insets (`20px`), and the split becomes (`1.45fr / 1fr`) with a (`305px`) readout minimum.
- At widths up to (`800px`), the console stacks in document order; the readout follows the library and its left divider becomes a top divider.
- At widths up to (`520px`), workspace gutters become (`14px`), the heading stacks, and the primary action fills the available width. Library insets become (`16px`), readout insets (`18px`).
- At widths from (`1600px`), workspace top padding increases to (`42px`). The body supports a minimum width of (`320px`).

Inventory remains a real fixed-layout table, inside a keyboard-focusable scroll region with sticky headers and a height cap (`min(58vh, 560px)`). Long titles wrap rather than becoming clipped single-line labels.

## Elevation & Depth

Depth primarily comes from tonal separation and thin borders. The console and primary button have small static shadows; the other surfaces remain quiet. There is no general elevated-card stack.

### Shadow Vocabulary
- **Primary action:** (`0 2px 3px rgb(24 52 94 / 12%)`).
- **Console enclosure:** (`0 3px 8px rgb(35 51 76 / 4%)`).

## Shapes

Controls use the recorded `5` radius; notices and badges use `4`; coverage and warning panels use `3`. The enclosing console has a slightly softer corner (`6px`), while rows stay ruled and rectangular. The circular connection indicator is intentional, not a reason to impose a blanket ban on rounded shapes.

## Components

### Buttons
Compact, semibold controls with distinct emphasis. Primary actions are blue-filled; secondary actions are white and outlined; header actions are transparent on slate; text actions are underlined.

The primary minimum height is (`46px`), secondary (`38px`). Hover changes color without movement. Disabled buttons use a not-allowed cursor and opacity (`0.53`). Keyboard focus uses a visible outline (`3px solid #1d62dd`, offset `4px`); on the masthead its color becomes (`#a8cbff`).

### Inputs / Fields
The labeled search field is white, outlined and full-width, with a minimum height (`42px`). Disabled fields use a pale-gray fill; help text remains directly beneath the control. It shares the global focus treatment.

### Navigation
A dark masthead pairs the home link with connection text and account actions. Account controls wrap on smaller screens; the small brand subtitle hides at the middle breakpoint and returns when the brand gets its own mobile row. A keyboard-visible skip link leads directly to the workspace.

### Cards / Containers
The shared console enclosure groups a white inventory plane and a lightly tinted readout plane, separated by a border. History and technical explanations use native disclosure controls and ruled content, not independent decorative cards.

### Status and feedback
Badges are small, textual status markers, not clickable chips. Empty, loading, error and stale-data feedback use plain language; retry controls stay with the relevant feedback. History exposes warnings, failures and available file links through expandable records.

### Backup readout
The visible bar is paired with a labeled native progress element and polite announcements. Its fill transitions by transform (`650ms cubic-bezier(0.16, 1, 0.3, 1)`); reduced motion removes the transition. Discovery uses a static short segment (`12%`), not an endless decorative animation.

## Do's and Don'ts

### Do:
- **Do** pair semantic color with explicit state text.
- **Do** retain visible keyboard focus, native disclosures and the labeled progress element.
- **Do** preserve wrapping for record titles and paths, and tabular alignment for counts.
- **Do** use tonal surfaces and rules to separate working regions.

### Don't:
- **Don't** replace real records or progress with invented metrics or unlabeled decoration.
- **Don't** flatten partial, interrupted and failed results into a generic success treatment.
- **Don't** remove progress information when reducing motion.
