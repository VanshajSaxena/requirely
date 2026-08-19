# CLAUDE.md — @requirely/web

@AGENTS.md

Requirely's web frontend. Read the root `CLAUDE.md` first for the product and the
loop invariant; read `packages/ui/CLAUDE.md` before touching anything visual.

> The `@AGENTS.md` line above is required. `next dev` maintains a marked block in
> `AGENTS.md` and expects `CLAUDE.md` to reference it. **It merges rather than
> clobbers** — hand-written content here survives (verified 2026-08-19) as long as
> that reference stays. Both files are committed, because `next dev` re-adds them
> anyway and an uncommitted regenerated file is permanent diff noise.

## Rendering policy

The point of choosing Next is to use it for what it is good at and delegate the
real work to `@requirely/core`. Pick per route, deliberately:

| Route kind | Strategy | Why |
| --- | --- | --- |
| Public / marketing | **SSG** | No per-request data. Prerendered HTML is the fastest thing that exists and the only thing crawlers index reliably. |
| Authenticated app | **CSR** | Per-user, behind auth, not indexable. Server-rendering it buys nothing and couples page latency to the engine's. |
| Anything needing fresh per-request server data | **SSR** | Only where a real requirement exists — not as a default. |

A route is static unless something makes it dynamic. Adding `'use client'` at the
page level, an uncached `fetch`, or a read of `cookies()`/`headers()` silently flips
it. `next build`'s route table marks static routes `○`; assert on
`.next/prerender-manifest.json` rather than on log wording, which changes between
releases.

`output: 'export'` is deliberately **not** set. It would make SSG obvious by making
route handlers and server actions impossible later. Per-route prerendering gives the
same HTML with no cliff.

## What this app may import from the engine

**`@requirely/core/domain` and nothing else.** That subpath is zod-only and has no
`node:` imports, so it is safe in a browser bundle; everything else in core reaches
Postgres. Enforced by `scripts/check-frontend-boundaries.sh` at the repo root, and by
core exporting exactly one subpath.

Sharing the domain rather than duplicating it is the whole point: `Question`,
`Answer` and `validateAnswer` are defined once, so a field rename breaks this app's
typecheck instead of shipping a silent mismatch. The answer UI should call the same
`validateAnswer` the engine calls before it spends tokens.

The seam is proven but currently unused — `@requirely/core` is not in this app's
dependencies. To use it: add `"@requirely/core": "workspace:*"`, and nothing else.
No `transpilePackages` entry is needed (verified). You will also need
`allowImportingTsExtensions: true` in `tsconfig.json` — it is deliberately absent while
core is unused, and TS5097 names the flag in its own message, so the failure tells you.

## Sharp edges

- **`experimental.useTypeScriptCli` defaults to true in Next 16.3 — leave it alone.**
  It makes `next build` shell out to the project-local `tsc` instead of TypeScript's
  JS compiler API. That is the *only* reason TypeScript 7 works here: TS 7.0 ships no
  JS API (planned for 7.1), so the in-process integration cannot load it.
- **`allowImportingTsExtensions` is deliberately absent, and would not be about this
  app's code.** An `exports`-map target that *is* a `.ts` file resolves with no compiler
  flag at all; the flag only governs `.ts` specifiers written in *source text*. It is
  needed only once `@requirely/core` is a dependency, because there is no TS project
  boundary (`composite` conflicts with core's `noEmit`), so `tsc` would then check core's
  files with this config. Measured: adding the dep plus one `import type { Question }`
  produces **68 × TS5097**; clean with the flag on.
- **`erasableSyntaxOnly` and `rewriteRelativeImportExtensions` are explicitly `false`**
  in `tsconfig.json`, not merely un-inherited. The base does not set them today; stating
  them means a future edit to the base cannot silently impose Node's stripping rules on
  a bundled React app.
- **`exactOptionalPropertyTypes` is *not* a tax on this stack.** An earlier version of
  this file claimed it was; that was reasoned, not measured. Counted over the installed
  `.d.ts` files, optional props carrying an explicit `| undefined`:

  | Package | clean |
  | --- | --- |
  | `@base-ui/react` 1.7.0 | **100%** — deliberately EOPT-authored; its shared mapped type even carries a `T extends undefined ? undefined` arm so `undefined` survives on forwarded DOM props |
  | `csstype` (backs `CSSProperties`) | 100% |
  | `@types/react` 19 | ~95%; the residue is optional *parameters*, which the flag does not touch |
  | `class-variance-authority` | clean — `VariantProps` writes `| undefined` into the mapped type, so a conditional `variant` is fine |
  | **`next/link`** | **0 / 14** |
  | **`next/image`** | **0 / 23** |
  | **`next/script`** | **0 / 7** |
  | `lucide-react` | 0 / 2 (`size`, `absoluteStrokeWidth`) |
  | `next-themes` | 13 / 15 (`nonce`, `scriptProps`) |

  So the friction is confined to `next/link`, `next/image`, `next/script`, lucide's
  `size`, and next-themes' `nonce` — **none of which this repo imports.** When it does
  bite, wrap those once in `packages/ui` with hygienic props and do the conditional
  spread inside the wrapper.

  **No vendored shadcn component needs a workaround.** The registry's pattern — type
  props off `X.Props` / `ComponentProps<…>` and spread the rest unchanged — is EOPT-safe
  because source and target are the same declaration. That is why the installed
  `button.tsx` compiles with no annotations.

- **The prop convention here is `p?: T | undefined` — both the `?:` and the explicit
  `| undefined`.** Not `p: T | undefined`: that is the domain-record convention from
  `packages/core`, and in JSX it forces every call site to pass the key. `?: T | undefined`
  is what Base UI and DefinitelyTyped use, and it gets the flag's benefit at zero
  call-site cost. If you hand-author a prop on a vendored component, never write `p?: T`
  bare — that is what breaks *callers*.
- **`next dev` does not rewrite `tsconfig.json`** at this version (verified). If it ever
  does, the diff is Next telling you which field it needs; read it, don't revert it.
- **`next/font/google` downloads fonts at build time.** A cold offline `next build` fails
  with a font error that reads like a bundler problem. `next/font/local` is the fix.
- **Biome auto-enables its React rule domain from the *nearest* `package.json`.** That is
  why this package has its own `biome.json` (`{"extends": "//"}`); a single root config
  would leave `useExhaustiveDependencies` off with no diagnostic.
- **`suppressHydrationWarning` on `<html>` is required by `next-themes`**, which writes
  the theme class before React hydrates. It is scoped to that one element — do not spread
  it further to silence real hydration bugs.

## Commands

```bash
pnpm dev                                       # next dev  (delegates here)
pnpm build                                     # next build
pnpm start                                     # next start, serves the build
pnpm --filter @requirely/web run typecheck     # next typegen && tsc --noEmit
```

`typecheck` runs `next typegen` first: it writes `next-env.d.ts` and `.next/types/`,
which `tsconfig.json` includes. Without it, a clean checkout fails before any build.
