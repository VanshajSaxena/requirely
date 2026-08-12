#!/usr/bin/env bash
# Enforces the architectural boundaries that keep the AI layer provider-agnostic.
# A convention documented only in prose decays silently; this fails CI instead.
#
# Rules:
#   1. domain/ may not import from any outer layer.
#   2. domain/ may not import third-party packages other than zod.
#   3. engine/ may not import adapters or app.
#   4. `ai` and `@ai-sdk/*` may only be imported under adapters/ai/.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# Emits "path:line: specifier" for every `from '<spec>'` in <dir> whose
# specifier matches <regex>. Silent when the directory does not exist yet.
find_imports() {
  local dir="$1" regex="$2"
  [ -d "$dir" ] || return 0
  grep -rnE "from ['\"]" "$dir" --include='*.ts' 2>/dev/null |
    sed -E "s/^([^:]+:[0-9]+):.*from ['\"]([^'\"]+)['\"].*$/\1: \2/" |
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

report "domain/ must not import an outer layer" \
  "$(find_imports src/domain '(\.\./)+(engine|adapters|app|ingestion|projection|config)(/.*)?')"

report "domain/ may only depend on zod and node: builtins" \
  "$(find_imports src/domain '[^.#].*' | grep -vE ': (zod(/.*)?|node:.*)$' || true)"

report "engine/ must not import adapters or app" \
  "$(find_imports src/engine '(\.\./)+(adapters|app)(/.*)?')"

# Rule 4 is the provider-agnostic constraint as an executable assertion.
ai_leaks=""
for dir in src/domain src/engine src/ingestion src/projection src/app src/config; do
  ai_leaks+="$(find_imports "$dir" '(ai|@ai-sdk/.*)')"$'\n'
done
for dir in src/adapters/*/; do
  case "$dir" in src/adapters/ai/) continue ;; esac
  ai_leaks+="$(find_imports "$dir" '(ai|@ai-sdk/.*)')"$'\n'
done
report "\`ai\`/\`@ai-sdk/*\` may only be imported under src/adapters/ai/" \
  "$(printf '%s' "$ai_leaks" | grep -vE '^\s*$' || true)"

if [ "$fail" -ne 0 ]; then
  printf '\nBoundary check failed.\n'
  exit 1
fi
printf 'Boundary check passed.\n'
