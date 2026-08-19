#!/usr/bin/env bash
# Asserts things about apps/web's BUILD OUTPUT that no static check can see.
#
# Its reason to exist: Tailwind treats a wrong `@source` path as a silent no-op —
# no error, no warning — so a broken cross-package class scan produces components
# that render unstyled with nothing anywhere reporting it. The only detectable
# signal is the emitted CSS. The same applies to a route silently going dynamic.
#
# Deliberately NOT part of `pnpm verify`: it needs a full build. Run via
# `pnpm verify:build`, which removes .next FIRST — that is not tidiness. Turbopack's
# incremental cache will happily serve the previous stylesheet, so with a warm .next
# this script passes against a deliberately broken @source. Measured: broken glob +
# warm cache => all checks green; same glob + rm -rf .next => all three CSS checks
# fail. A guard that can be fooled by a cache is not a guard.
set -uo pipefail
cd "$(dirname "$0")/.."

WEB=apps/web
NEXT="$WEB/.next"
fail=0

report() {
  printf '\n  ✗ %s\n' "$1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /'
  fail=1
}
ok() { printf '  ✓ %s\n' "$1"; }

[ -d "$NEXT" ] || {
  printf 'No build output at %s — run `pnpm build` first.\n' "$NEXT" >&2
  exit 1
}

# ---------------------------------------------------------------- static render
HTML="$NEXT/server/app/index.html"
if [ -f "$HTML" ]; then
  ok "/ prerendered to $HTML"
else
  report "/ did not prerender to HTML" \
    "expected $HTML — a 'use client' page, an uncached fetch, or a read of
cookies()/headers() turns the route dynamic"
fi

MANIFEST="$NEXT/prerender-manifest.json"
if [ -f "$MANIFEST" ] && grep -q '"/"' "$MANIFEST"; then
  ok "prerender-manifest lists /"
else
  report "prerender-manifest does not list /" \
    "asserted from the manifest rather than the build log, whose wording changes"
fi

# ------------------------------------------------- the whole rendering chain
# One assertion covering: workspace symlink -> packages/ui wildcard subpath export
# -> RSC render -> static prerender.
if [ -f "$HTML" ] && grep -q 'data-slot="button"' "$HTML"; then
  ok "the design system's Button reached the prerendered HTML"
else
  report "no Button in the prerendered HTML" \
    "breaks if the workspace link, packages/ui's exports map, or the RSC render broke"
fi

# ---------------------------------------------- Tailwind cross-package class scan
# Utilities that appear in packages/ui and NOWHERE in the app's own source. If they
# are missing from the emitted CSS, the kit-side `@source` stopped matching.
CSS_FILES=$(find "$NEXT" -name '*.css' -not -path '*cache*' 2>/dev/null)
if [ -z "$CSS_FILES" ]; then
  report "no CSS emitted at all" "expected a stylesheet under $NEXT"
else
  for u in bg-clip-padding shrink-0 select-none; do
    # The test only means something while the utility is absent from app source.
    if grep -rq -- "$u" "$WEB/app" "$WEB/components" 2>/dev/null; then
      report "'$u' is no longer kit-only" \
        "it now appears in apps/web source, so it cannot prove the cross-package
scan works. Pick another utility used only in packages/ui."
    elif printf '%s\n' "$CSS_FILES" | xargs grep -lq -- "$u" 2>/dev/null; then
      ok "kit-only utility '$u' survived into the app's CSS"
    else
      report "kit-only utility '$u' is MISSING from the built CSS" \
        "the @source in packages/ui/src/styles/globals.css is not matching. Tailwind
reports nothing for a bad @source path — this check is the only signal."
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  printf '\nFrontend artifact check failed.\n'
  exit 1
fi
printf 'Frontend artifact check passed.\n'
