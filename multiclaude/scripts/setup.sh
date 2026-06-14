#!/usr/bin/env bash
# multiclaude:setup — verify everything orchestrate + usage need, and print the
# exact fix for anything missing. Idempotent: safe to run repeatedly; the only
# side effect is pre-warming the ccusage cache.
set -uo pipefail

ok=0; miss=0
pass(){ printf '  ✓ %s\n' "$1"; ok=$((ok+1)); }
fail(){ printf '  ✗ %s\n      fix: %s\n' "$1" "$2"; miss=$((miss+1)); }
note(){ printf '  · %s\n' "$1"; }

# plugin root (this script lives in <root>/scripts/) + the shipped example settings
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(dirname "$HERE")"
SETTINGS_EXAMPLE="$ROOT/setup/settings.json"

if   command -v apt-get >/dev/null 2>&1; then PKG="sudo apt-get install -y"
elif command -v brew    >/dev/null 2>&1; then PKG="brew install"
elif command -v dnf     >/dev/null 2>&1; then PKG="sudo dnf install -y"
elif command -v pacman  >/dev/null 2>&1; then PKG="sudo pacman -S"
else PKG="<your package manager> install"; fi

echo "════════════════════════════════════════════════════════"
echo "  multiclaude setup check · $(date '+%Y-%m-%d %H:%M %Z')"
echo "════════════════════════════════════════════════════════"

echo; echo "▌ Core tools (usage)"
if command -v python3 >/dev/null 2>&1; then pass "python3 ($(python3 --version 2>&1 | awk '{print $2}'))"
else fail "python3 — parses usage data" "$PKG python3"; fi
if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then pass "GNU find (-printf)"
else fail "GNU find with -printf — codex session lookup" "$PKG findutils"; fi
if command -v bunx >/dev/null 2>&1;  then pass "bunx (runs ccusage)"
elif command -v npx >/dev/null 2>&1; then pass "npx (runs ccusage)"
else fail "bunx/npx (Node) — runs ccusage for Claude usage" "install Node.js: $PKG nodejs   (or https://nodejs.org)"; fi

echo; echo "▌ Codex — edit/implementation tasks"
if command -v codex >/dev/null 2>&1; then
  v=$(codex --version 2>/dev/null | head -1); pass "codex installed${v:+ ($v)}"
  if codex login status >/dev/null 2>&1; then pass "codex logged in"
  else fail "codex not logged in" "codex login"; fi
else
  fail "codex CLI" "curl -fsSL https://chatgpt.com/codex/install.sh | sh   (then: codex login)"
fi

echo; echo "▌ AGY — review/research/reasoning"
if command -v agy >/dev/null 2>&1; then
  v=$(agy --version 2>/dev/null | head -1); pass "agy installed${v:+ ($v)}"
  if timeout 30 agy models >/dev/null 2>&1; then pass "agy authenticated (models reachable)"
  else fail "agy not authenticated / unreachable" "run 'agy' once and complete sign-in"; fi
else
  fail "agy CLI" "curl -fsSL https://antigravity.google/cli/install.sh | bash   (then authenticate)"
fi

echo; echo "▌ Companion plugins (orchestrate §0)"
SETTINGS="$HOME/.claude/settings.json"
if grep -q 'superpowers@' "$SETTINGS" 2>/dev/null; then pass "superpowers plugin enabled"
else fail "superpowers plugin" "add marketplace + enabledPlugins per $SETTINGS_EXAMPLE"; fi
if grep -q 'claude-mem@' "$SETTINGS" 2>/dev/null; then pass "claude-mem plugin enabled"
else fail "claude-mem plugin" "add marketplace + enabledPlugins per $SETTINGS_EXAMPLE"; fi

echo; echo "▌ ccusage — Claude usage backend"
if command -v bunx >/dev/null 2>&1 || command -v npx >/dev/null 2>&1; then
  R="bunx"; command -v bunx >/dev/null 2>&1 || R="npx -y"
  if timeout 120 $R ccusage@latest --version >/dev/null 2>&1; then pass "ccusage reachable + cached ($R)"
  else fail "ccusage not reachable (needs network)" "check network, then: $R ccusage@latest --version"; fi
else
  note "skipped — needs bunx/npx first"
fi

echo; echo "▌ Usage snapshot hook (orchestrate §0/§5)"
if [ -f "$ROOT/hooks/hooks.json" ]; then pass "hooks/hooks.json present (auto-injects wallet headroom)"
else fail "hooks/hooks.json missing" "reinstall the multiclaude plugin"; fi
if [ -x "$ROOT/scripts/usage-snapshot.sh" ] && "$ROOT/scripts/usage-snapshot.sh" 2>/dev/null | grep -q 'multiclaude wallets'; then
  pass "usage-snapshot.sh runs (warms the headroom cache)"
else fail "usage-snapshot.sh not runnable" "chmod +x \"$ROOT/scripts/usage-snapshot.sh\" && bash \"$ROOT/scripts/usage-snapshot.sh\""; fi

echo
echo "════════════════════════════════════════════════════════"
if [ "$miss" -eq 0 ]; then
  echo "  ✓ all set — $ok checks passed."
  echo "    /multiclaude:orchestrate and /multiclaude:usage are ready."
else
  echo "  $ok ok · $miss to fix — run the 'fix:' commands above,"
  echo "  then re-run /multiclaude:setup to verify."
fi
echo "════════════════════════════════════════════════════════"
