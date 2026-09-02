#!/usr/bin/env bash
# Frontend counterpart to packages/core/scripts/check-boundaries.sh.
#
# Two scripts rather than one parameterized script, deliberately: core's rules
# are hexagonal layering inside one package (relative-path direction plus a
# zero-third-party allowlist Biome cannot express), while these are bare-specifier
# denylists across packages. A `case "$1"` dispatching to two disjoint rule sets
# would be two scripts wearing one filename, and $1 becomes a new way to get a
# silent pass.
#
# Rules:
#   7.  No *browser* package may import a server-only data dependency.
#   8.  apps/web may import @requirely/core/domain and nothing else under core.
#   9.  packages/ui knows nothing about the domain.
#   10. packages/ui may not import from apps/ — a library depending on an app is inverted.
#   11. packages/ui may not import node: builtins — the kit is isomorphic.
#   12. apps/cli may import @requirely/core/domain or /server, and nothing deeper.
#   13. apps/cli may not import ai/@ai-sdk/* — provider-agnostic, extended to the
#       app layer, which is the first place it has somewhere to leak *to*.
#
# Rules 7 and 8 name apps/web explicitly rather than scanning `apps` as a whole.
# They existed when `apps` meant "the browser", and widening a rule until it
# stops complaining is how a constraint dies. A CLI legitimately talks to
# Postgres; what it must not do is reach past core's published surface.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

IMPORT_LINE='^[[:space:]]*(import|export)[[:space:]].*[[:space:]]from[[:space:]]*['"'"'"]'

# NOTE: --include is repeated, not merged. The core script passes only '*.ts',
# which was invisible while the repo had no JSX — in a React codebase it would
# make every rule pass vacuously in every .tsx file.
find_imports() {
  local dir="$1" regex="$2"
  [ -d "$dir" ] || return 0
  grep -rnE "$IMPORT_LINE" "$dir" --include='*.ts' --include='*.tsx' 2>/dev/null |
    sed -E "s/^([^:]+:[0-9]+):.*[[:space:]]from[[:space:]]*['\"]([^'\"]+)['\"].*$/\1: \2/" |
    grep -E ": ($regex)$" || true
}

report() {
  local label="$1" hits="$2"
  if [ -n "$hits" ]; then
    printf '\n  ✗ %s\n' "$label"
    printf '%s\n' "$hits" | sed 's/^/      /'
    fail=1
  fi
}

# A wrong path here would make every rule below pass while checking nothing, and
# the script would still print "passed". Fail loudly instead.
# `apps/cli` is deliberately *not* required: rules 12 and 13 are silent until it
# exists, which is correct, and the abort guard covers what must always be there.
[ -d apps/web ] && [ -d packages/ui ] || {
  printf 'Frontend boundary check aborted: apps/web and packages/ui not found under %s\n' "$PWD" >&2
  exit 1
}

server_only='drizzle-orm(/.*)?|postgres|@electric-sql/pglite(/.*)?|drizzle-kit(/.*)?|pg-boss'
report "no browser package may import a server-only data dependency" \
  "$(find_imports apps/web "$server_only"; find_imports packages/ui "$server_only")"

# The engine's own layering rules do not reach across a package boundary, so the
# allowlist is what keeps postgres and pglite out of the browser bundle. Only
# src/domain/ is zod-only and therefore safe to ship to a client.
report "apps/web may import @requirely/core/domain and nothing else under @requirely/core" \
  "$(find_imports apps/web '@requirely/core(/.*)?' | grep -vE ': @requirely/core/domain$' || true)"

# Rule 12. The CLI is a server-side app, so `/server` is legitimate — but a deep
# path into `src/adapters/` would let it depend on core's internals, which is the
# thing the curated export surface exists to prevent. Node's `exports` map already
# hard-errors on those at runtime; this catches them at review time, and covers
# the relative-path escape (`../../packages/core/src/...`) that the map does not.
report "apps/cli may import only @requirely/core/domain or /server" \
  "$(find_imports apps/cli '(@requirely/core(/.*)?|(\.\./)+packages/core/.*)' |
      grep -vE ': @requirely/core/(domain|server)$' || true)"

# Rule 13. The provider-agnostic constraint, extended to the layer that finally
# has somewhere to leak to. An app that imported `ai` directly would be choosing
# a vendor above the port rather than behind it.
report "apps/cli must not import \`ai\`/\`@ai-sdk/*\` — providers live behind a port" \
  "$(find_imports apps/cli '(ai|@ai-sdk/.*)')"

report "packages/ui must not import @requirely/core — a design system knows no domain" \
  "$(find_imports packages/ui '@requirely/core(/.*)?')"

report "packages/ui must not import from apps/ — a library may not depend on an app" \
  "$(find_imports packages/ui '(@requirely/web(/.*)?|(\.\./)+apps/.*)')"

# The type-level half of this rule is `types: ["react","react-dom"]` in
# packages/ui/tsconfig.json. Removing either leaves it enforced only in prose.
report "packages/ui must not import node: builtins — the kit is isomorphic" \
  "$(find_imports packages/ui 'node:.*')"

if [ "$fail" -ne 0 ]; then
  printf '\nFrontend boundary check failed.\n'
  exit 1
fi
printf 'Frontend boundary check passed.\n'
