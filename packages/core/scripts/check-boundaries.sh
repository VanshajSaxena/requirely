#!/usr/bin/env bash
# Enforces the architectural boundaries that keep the AI layer provider-agnostic
# and the domain deterministic. A convention documented only in prose decays
# silently; this fails CI instead.
#
# Rules:
#   1. domain/ may not import from any outer layer.
#   2. domain/ may not import third-party packages other than zod (tests may use vitest).
#   3. engine/ may not import adapters or app.
#   4. `ai` and `@ai-sdk/*` may only be imported under an AI-vendor adapter
#      directory: adapters/ai/ (StructuredGenerator) or adapters/transcription/
#      (Transcriber). An explicit list, so adding a third is a reviewable diff
#      rather than a rule quietly widened until it stopped complaining.
#   5. Time, identity and randomness enter only via the Clock and IdGenerator ports.
#   6. wire/ may depend on domain/ and nothing else, and nothing in domain/ may
#      depend on wire/. The wire exists because *grammar compilers* have limits —
#      a fact about every provider, not about one — so a provider concern reaching
#      into it would turn a general encoding into a vendor workaround, and a
#      domain file reaching back into it would put the vendor's constraint inside
#      the model the constraint exists to protect.
#   7. src/server.ts contains re-exports and nothing else. Core exports pieces
#      and contracts; each app owns its own composition root. A library that
#      knows how to assemble itself knows about its applications, and would grow
#      flags or split per-app the moment a second one appeared.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

# find_imports is silent on a missing directory — correct for src/app, which does
# not exist yet, but it means a wrong cwd yields "passed" while checking nothing.
[ -d src/domain ] && [ -d src/engine ] && [ -d src/wire ] && [ -f src/server.ts ] || {
  printf 'Boundary check aborted: expected src/domain, src/engine, src/wire and src/server.ts under %s\n' "$PWD" >&2
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
  # `-e`, not `-d`: this is also called on `src/server.ts`, a single file, so
  # that the AI-leak scan covers the export surface too.
  [ -e "$dir" ] || return 0
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

# Rule 6, both directions. `engine/` may reach into `wire/` — it is what chooses
# a schema per operation — but nothing else may, and `wire/` may reach only
# `domain/`.
report "wire/ may only depend on domain/" \
  "$(find_imports src/wire '((\.\./)+|@requirely/core/)(engine|adapters|app|ingestion|projection|config|integration)(/.*)?')"

report "wire/ may only depend on zod among third-party packages" \
  "$(find_imports src/wire '[^.#].*' |
      grep -vE ': (zod(/.*)?|node:.*|vitest)$' || true)"

report "domain/ must not depend on wire/" \
  "$(find_imports src/domain '((\.\./)+|@requirely/core/)wire(/.*)?')"

# Rule 7: the export surface is a manifest, not a runtime.
#
# Two checks rather than one clever regex. The first is an allowlist over lines,
# which is precise but has to tolerate the shapes a multi-line `export { … }
# from` takes; the second is a denylist over keywords, which is imprecise but
# cannot be slipped past by reformatting. Either alone was gameable; together
# they caught every planted violation.
# The abort guard above already proved the file exists, so this is unconditional
# — a `[ -f ]` here would let a deleted export surface pass silently, which is
# the vacuous-pass shape this script has been bitten by before.
if true; then
  # Strip comments and blanks, then require what remains to be part of a
  # re-export: an `export` line, a closing brace, or a bare exported name.
  stray="$(
    grep -nvE '^[[:space:]]*($|//|/\*|\*)' src/server.ts |
      grep -vE ':[[:space:]]*(export[[:space:]{*]|\}[[:space:]]*(from|;)|(type[[:space:]]+)?[A-Za-z_$][A-Za-z0-9_$]*,?$)' || true
  )"
  report "src/server.ts may contain only re-exports" "$stray"

  # A manifest declares nothing and evaluates nothing. Catches the reformatted
  # version of the same violation — a `createRuntime` wrapped onto one line.
  declarations="$(
    grep -nE '(^|[^A-Za-z0-9_$])(function|class|=>|const|let|var|require\()([^A-Za-z0-9_$]|$)' src/server.ts |
      grep -vE '^[[:space:]]*[0-9]+:[[:space:]]*(//|\*|/\*)' || true
  )"
  report "src/server.ts may not declare or evaluate anything" "$declarations"
fi

# Rule 4 is the provider-agnostic constraint as an executable assertion.
ai_leaks=""
for dir in src/domain src/engine src/wire src/ingestion src/projection src/app src/config src/integration src/observability src/server.ts; do
  ai_leaks+="$(find_imports "$dir" '(ai|@ai-sdk/.*)')"$'\n'
done
for dir in src/adapters/*/; do
  case "$dir" in src/adapters/ai/ | src/adapters/transcription/) continue ;; esac
  ai_leaks+="$(find_imports "$dir" '(ai|@ai-sdk/.*)')"$'\n'
done
report "\`ai\`/\`@ai-sdk/*\` may only be imported under an AI-vendor adapter directory" \
  "$(printf '%s' "$ai_leaks" | grep -vE '^[[:space:]]*$' || true)"

# Rule 5: determinism. Without it, replayable snapshot tests of the loop decay
# one convenient call at a time.
nondeterminism=""
for dir in src/domain src/engine src/wire; do
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
