#!/usr/bin/env bash
# multiclaude:usage — external-wallet + orchestrator usage at a glance.
#   CODEX  : rate_limits from newest ~/.codex/sessions/**/*.jsonl   (real)
#   CLAUDE : active 5h block via ccusage over ~/.claude/projects    (real, needs net)
#   AGY    : tiers + note — CLI exposes no usage readout            (best-effort)
set -uo pipefail

rule() { printf '%s\n' "════════════════════════════════════════════════════════"; }
rule
echo "  multiclaude usage · $(date '+%Y-%m-%d %H:%M %Z')"
rule

# ── CODEX ───────────────────────────────────────────────
echo; echo "▌ CODEX  (ChatGPT — separate wallet)"
sess=$(find "$HOME/.codex/sessions" -type f -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2-)
if [ -n "${sess:-}" ] && [ -f "$sess" ]; then
  python3 - "$sess" <<'PY'
import sys, json, time
now=time.time(); rl=tu=None
with open(sys.argv[1], encoding='utf-8', errors='ignore') as f:
    for ln in f:
        if '"rate_limits"' not in ln and '"total_token_usage"' not in ln:
            continue
        try: o=json.loads(ln)
        except Exception: continue
        st=[o]
        while st:
            c=st.pop()
            if isinstance(c, dict):
                if isinstance(c.get('rate_limits'), dict): rl=c['rate_limits']
                if isinstance(c.get('total_token_usage'), dict): tu=c['total_token_usage']
                st += list(c.values())
            elif isinstance(c, list):
                st += c
def rs(ep):
    if not ep: return ''
    d=int(ep-now)
    return '· resets now' if d < 0 else f'· resets in {d//3600}h{(d%3600)//60:02d}m'
def bar(p):
    n=max(0, min(10, int(round((p or 0)/10)))); return '█'*n + '░'*(10-n)
if rl:
    for k, wm in (('primary',300), ('secondary',10080)):
        b=rl.get(k) or {}
        if not b: continue
        lab='5h    ' if wm==300 else 'weekly'
        up=b.get('used_percent') or 0
        print(f'  {lab}  {bar(up)} {up:5.1f}%  {rs(b.get("resets_at"))}')
    if rl.get('plan_type'): print(f'  plan: {rl["plan_type"]}')
    if tu: print(f'  latest session: {tu.get("total_tokens",0):,} tokens')
else:
    print('  (no rate-limit snapshot in latest session)')
PY
else
  echo "  no Codex session files yet (run codex once to populate)"
fi

# ── CLAUDE (orchestrator) ───────────────────────────────
echo; echo "▌ CLAUDE  (orchestrator — this wallet, active 5h block)"
ccjson=$(timeout 90 bunx ccusage@latest blocks --active --json 2>/dev/null) \
  || ccjson=$(timeout 90 npx -y ccusage@latest blocks --active --json 2>/dev/null) \
  || ccjson=""
if [ -n "$ccjson" ]; then
  cc_tmp=$(mktemp); printf '%s' "$ccjson" > "$cc_tmp"
  python3 - "$cc_tmp" <<'PY'
import sys, json
try:
    with open(sys.argv[1], encoding='utf-8', errors='ignore') as fh: d=json.load(fh)
except Exception:
    print('  (ccusage returned no parseable data)'); sys.exit(0)
bl=[b for b in d.get('blocks',[]) if b.get('isActive')]
if not bl: print('  (no active 5h block — idle)'); sys.exit(0)
b=bl[0]; tc=b.get('tokenCounts',{}) or {}
tot=sum(v for v in tc.values() if isinstance(v,(int,float)))
br=b.get('burnRate') or {}; pr=b.get('projection') or {}
print(f'  cost:   ${b.get("costUSD",0):.2f}   (proj ${pr.get("totalCost",0):.0f} by block end)')
print(f'  tokens: {int(tot):,}   (proj {int(pr.get("totalTokens",0)):,})')
if br.get('tokensPerMinute'): print(f'  burn:   {int(br["tokensPerMinute"]):,} tok/min')
if pr.get('remainingMinutes') is not None: print(f'  window: {int(pr["remainingMinutes"])}m left in block')
if b.get('models'): print(f'  models: {", ".join(b["models"])}')
PY
  rm -f "$cc_tmp"
else
  echo "  ccusage unavailable (needs network for bunx/npx)"
fi

# ── AGY ─────────────────────────────────────────────────
echo; echo "▌ AGY  (Antigravity — Gemini/Claude tiers, separate wallet)"
if command -v agy >/dev/null 2>&1; then
  tiers=$(timeout 30 agy models 2>/dev/null | sed 's/^/    /' | head -12)
  [ -n "$tiers" ] && { echo "  available tiers:"; printf '%s\n' "$tiers"; }
else
  echo "  agy CLI not found"
fi
echo "  usage %: not exposed by the AGY CLI — Gemini/Claude quota is enforced"
echo "           reactively (resource_exhausted / 429). See orchestrate §5."
echo
