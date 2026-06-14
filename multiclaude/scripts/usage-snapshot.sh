#!/usr/bin/env bash
# multiclaude:usage-snapshot — compact, CACHED wallet-headroom line for the
# orchestrate hooks (SessionStart + PreToolUse on Task|Workflow).
#
# Design: never block a dispatch on the network. The slow read is ccusage
# (Claude block); the Codex/AGY reads are instant local files. So this prints
# whatever is cached IMMEDIATELY and kicks off a background refresh when the
# cache is stale — the hot path is ~0. First-ever call shows Codex+AGY now and
# fills in the Claude block on the next dispatch.
#
# Plain text by default (handy to run by hand); `--hook <EVENT>` wraps the line
# as Claude Code additionalContext JSON for that hook event.
set -uo pipefail

# Reach node/bun + the CLIs even under a minimal hook PATH.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
command -v bunx >/dev/null 2>&1 || command -v npx >/dev/null 2>&1 \
  || export PATH="$($SHELL -lc 'echo $PATH' 2>/dev/null):$PATH"

TTL=${MULTICLAUDE_USAGE_TTL:-300}                       # seconds a snapshot stays fresh
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/multiclaude"
CACHE="$CACHE_DIR/usage.txt"
LOCK="$CACHE_DIR/refresh.lock"
mkdir -p "$CACHE_DIR" 2>/dev/null

HOOK_EVENT=""
[ "${1:-}" = "--hook" ] && HOOK_EVENT="${2:-}"

now()   { date +%s; }
stamp() { date '+%H:%M %Z'; }
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

emit() {                                                # raw text, or hook JSON
  if [ -n "$HOOK_EVENT" ]; then
    EV="$HOOK_EVENT" python3 - "$1" <<'PY'
import json, os, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": os.environ["EV"],
      "additionalContext": sys.argv[1]}, "suppressOutput": True}))
PY
  else
    printf '%s\n' "$1"
  fi
}

codex_line() {
  local sess
  sess=$(find "$HOME/.codex/sessions" -type f -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
         | sort -rn | head -1 | cut -d' ' -f2-)
  [ -n "${sess:-}" ] && [ -f "$sess" ] || { echo "CODEX no session yet"; return; }
  python3 - "$sess" <<'PY'
import sys, json, time
now=time.time(); rl=None
with open(sys.argv[1], encoding='utf-8', errors='ignore') as f:
    for ln in f:
        if '"rate_limits"' not in ln: continue
        try: o=json.loads(ln)
        except Exception: continue
        st=[o]
        while st:
            c=st.pop()
            if isinstance(c, dict):
                if isinstance(c.get('rate_limits'), dict): rl=c['rate_limits']
                st += list(c.values())
            elif isinstance(c, list): st += c
def rs(ep):
    if not ep: return ''
    d=int(ep-now)
    if d < 0: return 'reset now'
    h, m = d//3600, (d%3600)//60
    return f'reset {h}h{m:02d}m' if h else f'reset {m}m'
if not rl:
    print('CODEX no rate-limit snapshot'); raise SystemExit
parts=[]
for k, lab in (('primary','5h'), ('secondary','wk')):
    b=rl.get(k) or {}
    if not b: continue
    up=b.get('used_percent') or 0
    r=rs(b.get('resets_at'))
    parts.append(f'{lab} {up:.0f}%' + (f' ({r})' if r else ''))
s='CODEX ' + ' / '.join(parts) if parts else 'CODEX no limits'
if rl.get('plan_type'): s += f' / {rl["plan_type"]}'
print(s)
PY
}

claude_line() {                                         # the slow one (network)
  local j tmp
  j=$(timeout 90 bunx ccusage@latest blocks --active --json 2>/dev/null) \
    || j=$(timeout 90 npx -y ccusage@latest blocks --active --json 2>/dev/null) \
    || j=""
  [ -n "$j" ] || { echo "CLAUDE ccusage unavailable (needs net)"; return; }
  tmp=$(mktemp); printf '%s' "$j" > "$tmp"             # tmpfile, not stdin (ccusage stdin-parse bug)
  python3 - "$tmp" <<'PY'
import sys, json
try:
    with open(sys.argv[1], encoding='utf-8', errors='ignore') as fh: d=json.load(fh)
except Exception:
    print('CLAUDE ccusage unparseable'); raise SystemExit
bl=[b for b in d.get('blocks',[]) if b.get('isActive')]
if not bl: print('CLAUDE block idle'); raise SystemExit
b=bl[0]; br=b.get('burnRate') or {}; pr=b.get('projection') or {}
s=f'CLAUDE blk ${b.get("costUSD",0) or 0:.2f}'
tpm=br.get('tokensPerMinute')
if tpm: s += f' / {int(tpm/1000)}k tok/min' if tpm >= 1000 else f' / {int(tpm)} tok/min'
if pr.get('remainingMinutes') is not None: s += f' / {int(pr["remainingMinutes"])}m left'
if pr.get('totalCost'): s += f' / proj ${pr["totalCost"]:.0f}'
print(s)
PY
  rm -f "$tmp"
}

agy_line() { echo "AGY: no usage readout, reactive"; }  # static + instant (no network)

generate() {                                            # $1 = full | fast
  local c a cl
  c=$(codex_line); a=$(agy_line)
  if [ "$1" = full ]; then cl=$(claude_line); else cl="CLAUDE refreshing"; fi
  printf '[multiclaude wallets @ %s] %s | %s | %s. Bias dispatch to the wallet with headroom; do not start work a 5h or weekly window cannot finish before its reset (orchestrate s5).' \
    "$(stamp)" "$c" "$cl" "$a"
}

# ── serve cache, refresh in background ──────────────────
age=999999
[ -f "$CACHE" ] && age=$(( $(now) - $(mtime "$CACHE") ))

if [ -f "$CACHE" ] && [ "$age" -le "$TTL" ]; then
  emit "$(cat "$CACHE")"                               # fresh — done, nothing slow
  exit 0
fi

if [ -f "$CACHE" ]; then
  emit "$(cat "$CACHE") [refreshing]"                  # stale — show it, refresh below
else
  emit "$(generate fast)"                              # cold — Codex+AGY now, Claude next time
fi

# single-flight background full refresh (clear a stale lock first)
[ -d "$LOCK" ] && [ "$(( $(now) - $(mtime "$LOCK") ))" -gt 180 ] && rmdir "$LOCK" 2>/dev/null
if mkdir "$LOCK" 2>/dev/null; then
  ( generate full > "$CACHE.tmp" 2>/dev/null && mv -f "$CACHE.tmp" "$CACHE"
    rmdir "$LOCK" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi
exit 0
