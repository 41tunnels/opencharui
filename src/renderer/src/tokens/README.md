# Design tokens — 41tunnels

Source of truth: the **41tunnels Design System** project on claude.ai/design
(`4dabf874-bc30-40dc-a17b-ca447c5dfd31`). The `.css` files here are verbatim copies
so a future pull diffs cleanly. **Don't hand-edit them** — change the upstream
project and re-sync.

The screen designs this app is built against live in the same project under
`ui_kits/opencharui/`, alongside a README arguing the three palette decisions the
design system does not make for you (no red, thought text italic rather than
purple, and where copper is allowed to appear).

`fonts.css` is not copied: upstream ships an `@import` from fonts.googleapis.com,
and this app must not make a third-party request on first paint. `main.ts` imports
the same two faces — IBM Plex Sans + IBM Plex Mono — from `@fontsource`, served
from our own bundle. Faces, weights and family names are unchanged.

## Light and dark

There is no dark _mode_, there are dark _surfaces_. `data-surface="dark"` on any
element re-resolves every semantic token beneath it. The theme toggle sets it on
`<html>`, so it covers the whole app; `applyTheme()` in `src/shared/theme.ts` keeps
it in step with the older `html.dark` class and `color-scheme`.

## Tailwind

`tailwind.config.js` bridges the semantic colours as Tailwind colour names
(`bg-page`, `text-muted`, `border-hairline`, …). Because each one is declared as
`var(--surface-page)` rather than a resolved hex, the utility re-resolves per
element and `[data-surface="dark"]` keeps flipping whole subtrees.

Spacing and radius are deliberately **not** bridged — the design system's spacing
scale (4, 8, 12, 16, 22, 28, 36, 48, 64, 72, 96) diverges from Tailwind's above
`space-4`, and silently redefining what `p-5` means would be worse than being
explicit. Use Tailwind utilities for incidental layout and the `ui-*` component
classes in `app.css` for anything the design specifies.
