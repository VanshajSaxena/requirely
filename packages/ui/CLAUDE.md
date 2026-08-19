# CLAUDE.md — @requirely/ui

Requirely's design system. Read the root `CLAUDE.md` first.

## Status: primitives only, no identity yet

Scaffolded from shadcn/ui with the **`b0` preset**, which decodes to style `nova`,
`baseColor`/`theme`/`chartColor` all `neutral`, `lucide` icons, Inter, default radius.
That is deliberately **opinion-free**. Requirely's actual visual identity is a separate,
explicitly deferred task: reference material will be supplied, primitives extracted from
it, and those translated into the CSS variables in `src/styles/globals.css`.

Until then: **do not invent visual decisions here.** A placeholder that looks unfinished
is honest; a placeholder that looks designed will be mistaken for a decision.

## Conventions

- **Base UI** (`@base-ui/react`, currently 1.7.0 — stable, from the Radix authors) is the
  primitive layer, chosen because it is shadcn v4's default, so the registry and future
  blocks are authored against it. Note the package rename: `@base-ui-components/react` is
  the *old* name and is stale at `1.0.0-rc.0`. Do not install it.
- **React 19 removed `forwardRef`** — `ref` is a plain prop, and `React.ElementRef` is
  deprecated in favour of `React.ComponentRef`. The registry reflects this; snippets
  copied from older posts will typecheck while reintroducing a pattern nothing else here
  uses.
- **Tokens live in `src/styles/globals.css`**, reached through `@theme inline`. Components
  consume semantic tokens (`bg-primary`, `text-muted-foreground`), never raw colours. That
  indirection is what makes the deferred design pass a token edit rather than a rewrite.
- `tailwind.config` must stay the **empty string** in both `components.json` files. Any
  non-empty value routes the shadcn CLI down its v3 path, where it tries to patch a
  `tailwind.config.js` that does not exist.
- After `shadcn add`, run `pnpm lint:fix` from the root. The registry emits double quotes;
  this repo uses single. `pnpm lint` failing right after an `add` is expected, not a bug.

## The isomorphic constraint

This package may not import `node:` builtins, `@requirely/core`, or anything under
`apps/`. A design system that knows the domain is no longer a design system, and one that
touches Node cannot render in a browser.

Enforced twice, on purpose:

- **Type level** — `types: ["react", "react-dom"]` in `tsconfig.json`, with no `"node"`.
  `process`, `Buffer` and `node:*` are simply not in scope.
- **CI** — rules 9–11 in `scripts/check-frontend-boundaries.sh` at the repo root.

Remove either and the rule survives only in prose.

## Tailwind v4 across the package boundary

**Each package declares only its own sources.** This one has

```css
@source "../**/*.{ts,tsx}";      /* -> packages/ui/src */
```

and `apps/web/app/globals.css` has its own `@source "../**"` for `apps/web`. Neither
reaches outside itself, so moving either package cannot silently break detection.

The kit-side line is **strictly necessary**. Tailwind's automatic source detection is
rooted at the PostCSS plugin's `base`, defaulting to `process.cwd()` — the consuming app —
and it **hard-skips `node_modules`**, so it can never reach this package through the
workspace symlink. `@source` resolves against the directory of the file that literally
contains it, and the resolver follows symlinks to the realpath.

**The failure mode is silent and total.** A utility used only here and not covered by a
correct `@source` is dropped from the app's stylesheet: the component renders unstyled,
with no build error, no warning, and nothing in the console. `scripts/check-frontend-artifacts.sh`
(`pnpm verify:build`) exists solely because the emitted CSS is the only detectable signal —
and it was proven by deliberately breaking this `@source` and watching it fail.

Traps, all verified against the installed `tailwindcss@4.3.3`:

- **A wrong `@source` path is a no-op, not an error.** The original template shipped
  `@source "../../../apps/**"`, which from `src/styles/` resolves to `packages/apps/**` —
  a directory that does not exist. It scanned nothing, invisibly, for as long as it existed.
- **Bare package specifiers do not work.** `@source "@requirely/ui"` silently matches
  nothing; `@source` patterns never go through the module resolver.
- **Never point `@source` at a bare directory inside `node_modules`.** The built-in ignore
  list stops applying for that source and it will walk the whole dependency tree
  (measured: ~8000 files).
- **Turbopack's incremental cache hides all of this.** With a warm `.next`, a broken
  `@source` still produces the previous, correct stylesheet — which is why
  `pnpm verify:build` removes `.next` before building.

`@import "shadcn/tailwind.css"` is why `shadcn` is a **dependency**, not a devDependency.
Removing it breaks the stylesheet, not the CLI.

## This package can never be consumed by Node

`.tsx` is not in Node's type-stripping extension map: importing one gives
`ERR_UNKNOWN_FILE_EXTENSION`. The kit is bundler-only, permanently, by construction. That
is fine and expected — but do not try to make it Node-runnable, and do not model it on
`packages/core`, which is source-only *and* Node-runnable and has a different set of
constraints as a result.

## Commands

```bash
pnpm --filter @requirely/ui run typecheck
pnpm dlx shadcn@latest add <component> --cwd packages/ui   # primitives land here
pnpm lint:fix                                              # then always this
```

Primitives install here; page-level blocks install to `apps/web/components`. The CLI routes
them from the two `components.json` files, whose `style`, `iconLibrary` and `baseColor` must
stay identical.
