#!/usr/bin/env bash
# Asserts that this package can actually be EXECUTED by Node, which is the bet the
# whole source-only design rests on and the only invariant here that no other gate
# can see.
#
# Why a third script rather than a rule inside check-boundaries.sh: those rules are
# greps over source text. These two are properties of the install topology and of
# Node's parser — neither is expressible as a pattern, and both need a real `node`
# process to observe. Keeping them apart means a change to one cannot vacuously
# disable the other.
#
# What each existing gate CANNOT see, measured on Node 24.19 / vitest 4.1.10:
#   `pnpm test`      transpiles with vitest's own pipeline. A file containing
#                    `export enum X {}` runs 9/9 green under vitest and dies with
#                    ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX under node.
#   `pnpm typecheck` catches that one (TS1294) and a missing .ts extension (TS2835),
#                    so it is load-bearing far beyond "I want these errors" — but it
#                    is blind to rule 1 below, which is not about source at all.
#   `pnpm lint`      blind to both.
#
# Rules:
#   1. This package's realpath must not sit under node_modules — Node refuses to
#      type-strip such a file regardless of how it was imported.
#   2. Every non-test module under src/ must import cleanly in a real Node process.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

report() {
  local label="$1" detail="${2:-}"
  printf '\n  ✗ %s\n' "$label"
  [ -n "$detail" ] && printf '%s\n' "$detail" | sed 's/^/      /'
  fail=1
}
ok() { printf '  ✓ %s\n' "$1"; }

# Same reasoning as the abort guard in check-boundaries.sh: a wrong cwd must fail
# loudly rather than print "passed" after checking nothing.
[ -d src/domain ] && [ -d src/engine ] || {
  printf 'Node-runnable check aborted: no src/domain and src/engine under %s\n' "$PWD" >&2
  exit 1
}

# ------------------------------------------------------------------ rule 1: realpath
# Node keys its refusal on the file's REALPATH, not on the specifier or the resolved
# path. That is why the pnpm symlink farm works and why `cp -r` of the identical bytes
# does not — the invariant belongs to the install layout, so no compiler, linter or
# bundler can observe it. Measured breakers: --preserve-symlinks; a deploy that COPIES
# this package into a consumer's node_modules (pnpm's injected path does exactly this);
# any Docker or publish step that copies rather than links. See CLAUDE.md.
REAL=$(node -e 'console.log(require("node:fs").realpathSync(process.cwd()))')
realpath_ok=1
case "$REAL" in
  */node_modules/*)
    realpath_ok=0
    report "this package's realpath is under node_modules — Node cannot type-strip it" \
      "realpath: $REAL
Node would fail every import with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING at
RUNTIME. Either link the package instead of copying it, or build it — the
config-only emit delta is in CLAUDE.md."
    ;;
  *) ok "realpath is outside node_modules ($REAL)" ;;
esac

# ------------------------------------------------------------- rule 2: it really runs
# One node process importing every module, rather than one process per file: same
# coverage, a fraction of the startup cost. A parse failure surfaces as a rejected
# dynamic import, so each file is attributed individually instead of aborting the run.
#
# Test files are excluded deliberately — they are executed by vitest, never by Node,
# and importing one outside the runner fails for an unrelated reason. `tsc` still
# holds them to erasableSyntaxOnly, so nothing is left unguarded.
FILES=$(find src -name '*.ts' -not -name '*.test.ts' | sort)
COUNT=$(printf '%s\n' "$FILES" | grep -c . || true)

# When rule 1 has already failed, rule 2 can only restate it once per file — and the
# path differs in every message, so the grouping below cannot collapse them. Skip it:
# the cause is already reported, and 49 lines of the same finding buries it.
if [ "$realpath_ok" -eq 0 ]; then
  printf '  – skipped the import check: every module would fail for the reason above\n'
# A find that matches nothing would otherwise make this rule pass vacuously.
elif [ "$COUNT" -eq 0 ]; then
  report "no modules found under src/ to import" \
    "check-node-runnable.sh matched zero files — the rule would pass while checking nothing"
else
  # `import`, not `require`: with --input-type=module the top-level await below makes
  # a require() call ERR_AMBIGUOUS_MODULE_SYNTAX rather than a syntax error.
  #
  # Failures are grouped by error rather than listed per file. One broken module fails
  # every importer of it — measured: a single bad specifier in domain/inquiry produced
  # 28 identical lines — so the raw list buries the cause it is meant to surface.
  IMPORT_ERRORS=$(printf '%s\n' "$FILES" | node --input-type=module -e '
    const { readFileSync } = await import("node:fs");
    const list = readFileSync(0, "utf8").trim().split("\n");
    const groups = new Map();
    for (const f of list) {
      try {
        await import("./" + f);
      } catch (e) {
        const code = e?.code ?? e?.name ?? "unknown";
        const key = `${code} — ${String(e?.message ?? e).split("\n")[0]}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }
    }
    for (const [key, files] of groups) {
      const extra = files.length > 1 ? ` (and ${files.length - 1} importer(s) of it)` : "";
      console.log(`${files[0]}${extra}: ${key}`);
    }
  ' 2>&1)
  node_status=$?

  # The exit status is checked as well as the output: this rule reports by *printing*, so
  # a node process that died before printing anything would otherwise be a silent pass.
  # (Reached for real while writing this script — see the ERR_AMBIGUOUS_MODULE_SYNTAX note
  # above, which did print. The empty-output case is the one this guards.)
  if [ -n "$IMPORT_ERRORS" ]; then
    report "some modules cannot be executed by Node" "$IMPORT_ERRORS"
  elif [ "$node_status" -ne 0 ]; then
    report "the import check itself failed (node exited $node_status with no output)" \
      "check-node-runnable.sh could not prove anything — treat as a failure, not a pass"
  else
    ok "all $COUNT modules under src/ import cleanly under node $(node --version)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  printf '\nNode-runnable check failed.\n'
  exit 1
fi
printf 'Node-runnable check passed.\n'
