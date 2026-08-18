#!/usr/bin/env bash
# Enforces the architectural boundaries that keep the AI layer provider-agnostic
# and the domain deterministic. A convention documented only in prose decays
# silently; this fails CI instead.
#
# Rules:
#   1. domain/ may not import from any outer layer.
#   2. domain/ may not import third-party packages other than zod (tests may use vitest).
#   3. engine/ may not import adapters or app.
#   4. `ai` and `@ai-sdk/*` may only be imported under adapters/ai/.
#   5. Time, identity and randomness enter only via the Clock and IdGenerator ports.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# find_imports is silent on a missing directory — correct for src/app, which does
# not exist yet, but it means a wrong cwd yields "passed" while checking nothing.
[ -d src/domain ] && [ -d src/engine ] || {
  printf 'Boundary check aborted: no src/domain and src/engine under %s\n' "$PWD" >&2
  exit 1
}

# Matches real module syntax only. An earlier version grepped for `from '` and
# flagged the word "from" inside comments and template literals — a checker that
# reports false positives is a checker people switch off.
IMPORT_LINE='^[[:space:]]*(import|export)[[:space:]].*[[:space:]]from[[:space:]]*['"'"'"]'

# Emits "path:line: specifier" for every import in <dir> whose specifier matches
# <regex>. Silent when the directory does not exist yet.
find_imports() {
  local dir="$1" regex="$2"
  [ -d "$dir" ] || return 0
  grep -rnE "$IMPORT_LINE" "$dir" --include='*.ts' --include='*.tsx' 2>/dev/null |
    sed -E "s/^([^:]+:[0-9]+):.*[[:space:]]from[[:space:]]*['\"]([^'\"]+)['\"].*$/\1: \2/" |
    grep -E ": ($regex)$" || true
}

# Greps for code matches, discarding comment-only lines so a rule cannot be
# tripped by the doc comment that explains it.
find_in_code() {
  local dir="$1" regex="$2"
  [ -d "$dir" ] || return 0
  grep -rnE "$regex" "$dir" --include='*.tsx' --include='*.ts' 2>/dev/null |
    grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' || true
}

report() {
  local label="$1" hits="$2"
  if [ -n "$hits" ]; then
    printf '\n  ✗ %s\n' "$label"
    printf '%s\n' "$hits" | sed 's/^/      /'
    fail=1
  fi
}

report "domain/ must not import an outer layer" \
  "$(find_imports src/domain '(\.\./)+(engine|adapters|app|ingestion|projection|config)(/.*)?')"

# Test files legitimately import vitest; production domain code may not import
# anything but zod and node: builtins.
report "domain/ may only depend on zod and node: builtins" \
  "$(find_imports src/domain '[^.#].*' |
      grep -vE '^[^:]*\.test\.tsx?:' |
      grep -vE ': (zod(/.*)?|node:.*)$' || true)"

report "domain/ test files may only add vitest" \
  "$(find_imports src/domain '[^.#].*' |
      grep -E '^[^:]*\.test\.tsx?:' |
      grep -vE ': (zod(/.*)?|node:.*|vitest)$' || true)"

report "engine/ must not import adapters or app" \
  "$(find_imports src/engine '((\.\./)+|@requirely/core/)(adapters|app)(/.*)?')"

# Rule 4 is the provider-agnostic constraint as an executable assertion.
ai_leaks=""
for dir in src/domain src/engine src/ingestion src/projection src/app src/config src/integration; do
  ai_leaks+="$(find_imports "$dir" '(ai|@ai-sdk/.*)')"$'\n'
done
for dir in src/adapters/*/; do
  case "$dir" in src/adapters/ai/) continue ;; esac
  ai_leaks+="$(find_imports "$dir" '(ai|@ai-sdk/.*)')"$'\n'
done
report "\`ai\`/\`@ai-sdk/*\` may only be imported under src/adapters/ai/" \
  "$(printf '%s' "$ai_leaks" | grep -vE '^[[:space:]]*$' || true)"

# Rule 5: determinism. Without it, replayable snapshot tests of the loop decay
# one convenient call at a time.
nondeterminism=""
for dir in src/domain src/engine; do
  nondeterminism+="$(find_in_code "$dir" \
    '(Date\.now\(|new Date\(|crypto\.randomUUID\(|Math\.random\()')"$'\n'
done
report "time, identity and randomness may only enter via the Clock/IdGenerator ports" \
  "$(printf '%s' "$nondeterminism" | grep -vE '^[[:space:]]*$' || true)"

if [ "$fail" -ne 0 ]; then
  printf '\nBoundary check failed.\n'
  exit 1
fi
printf 'Boundary check passed.\n'
