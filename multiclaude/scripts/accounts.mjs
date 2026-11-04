#!/usr/bin/env node
// multiclaude accounts — several Claude Code logins that count as ONE Claude
// wallet. Ported in spirit from claude-swap (MIT, see THIRD_PARTY_NOTICES.md).
//
//   accounts [list] [--refresh] [--json]   every account's 5h / 7d usage + the pool
//   accounts status [--json]               the active account, one line
//   accounts add [--slot N] [--alias A]    store the account you are logged in with now
//   accounts remove <id>
//   accounts switch [<id>]                 activate <id> (num | email | alias); none = next usable
//   accounts alias <id> <name> | --unset
//   accounts disable <id> | enable <id>    keep an account out of auto-switch / rotation
//   accounts threshold <id> <pct> | --unset
//   accounts auto [--once] [--dry-run] [--json] [--threshold N] [--weekly-threshold N]
//                 [--strategy best|consume-first] [--model NAME] [--interval S]
//   accounts config [get | set <key> <value>]
//   accounts run <id> [--share-history] [-- <claude args>]   claude as <id> in THIS terminal only
//   accounts pool --json                   pool aggregate (for the headroom hook)
//
// Exit codes: 0 ok (auto: switched) · 1 error · 2 auto: nothing to do · 3 auto: blocked.
import { spawn } from 'node:child_process';
import * as A from './lib/accounts.mjs';
import { which, bar } from './lib/mc.mjs';

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const passthru = dd >= 0 ? argv.slice(dd + 1) : [];
const args = dd >= 0 ? argv.slice(0, dd) : argv;
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const json = flag('--json');
const out = (v, text) => console.log(json ? JSON.stringify(v) : text);

const pct = (x) => (typeof x === 'number' ? `${Math.round(x)}%` : '—');
function until(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d${h}h` : h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}
const age = (ts) => (ts ? until(Date.now() * 2 - ts) : '');

function render(s) {
  const L = [];
  if (!s.accounts.length) {
    L.push('No Claude accounts stored yet.', '', 'Log in with Claude Code (`claude`, then /login) and run:  accounts add',
      'Repeat for each account. Do NOT /logout in between: it can revoke the token you just stored.');
    if (s.unmanagedLive) L.push('', `Current login: ${s.unmanagedLive} (not stored yet).`);
    return L.join('\n');
  }
  const p = s.pool;
  L.push(p
    ? `CLAUDE wallet: ${p.accounts} account(s) pooled · 5h ${bar(p.fiveHour)} ${pct(p.fiveHour)}${p.fiveHourReset ? ` (next reset ${until(p.fiveHourReset)})` : ''} · 7d ${pct(p.sevenDay)}`
    : 'CLAUDE wallet: no fresh usage yet (accounts list --refresh)');
  L.push('');
  for (const a of s.accounts) {
    const u = a.usage || {};
    const tags = [a.active && 'ACTIVE', a.alias && `alias ${a.alias}`, a.disabled && 'disabled', a.dead && 'DEAD TOKEN — re-login + accounts add',
      a.threshold != null && `th ${a.threshold}%`, a.session.length && `session pid ${a.session.join(',')}`].filter(Boolean);
    L.push(`${a.active ? '▶' : ' '} #${a.slot} ${a.email}${a.orgName && !a.orgName.includes(a.email) ? ` · ${a.orgName}` : ''}${a.plan ? ` · ${a.plan}` : ''}${tags.length ? `  [${tags.join(' · ')}]` : ''}`);
    if (u.fiveHour || u.sevenDay) {
      L.push(`     5h ${bar(u.fiveHour?.pct)} ${pct(u.fiveHour?.pct).padStart(4)}  resets ${until(u.fiveHour?.resetsAt) || '—'}`);
      L.push(`     7d ${bar(u.sevenDay?.pct)} ${pct(u.sevenDay?.pct).padStart(4)}  resets ${until(u.sevenDay?.resetsAt) || '—'}`);
      for (const sc of u.scoped || []) L.push(`     ${sc.name}: ${pct(sc.pct)}${sc.resetsAt ? `  resets ${until(sc.resetsAt)}` : ''}`);
    }
    if (u.error) L.push(`     usage: ${u.error}${u.fetchedAt ? ` (showing data from ${age(u.fetchedAt)} ago)` : ''}`);
    else if (u.fetchedAt) L.push(`     (read ${age(u.fetchedAt)} ago)`);
  }
  if (s.unmanagedLive) L.push('', `Current login ${s.unmanagedLive} is not stored — run: accounts add`);
  const c = s.config.auto;
  L.push('', `auto-switch: ${c.enabled ? 'on' : 'off'} · ${c.strategy} · line ${c.threshold}%${c.weeklyThreshold != null ? ` (7d ${c.weeklyThreshold}%)` : ''}${c.model ? ` · +${c.model} weekly` : ''} · cooldown ${c.cooldownSec}s`);
  if (s.lastSwitch) L.push(`last switch: #${s.lastSwitch.from ?? '?'} → #${s.lastSwitch.to} ${age(s.lastSwitch.at)} ago (${s.lastSwitch.reason})`);
  return L.join('\n');
}

const autoOverrides = () => {
  const o = {};
  const th = opt('--threshold'), wt = opt('--weekly-threshold'), st = opt('--strategy'), md = opt('--model');
  if (th) o.threshold = Number(th);
  if (wt) o.weeklyThreshold = Number(wt);
  if (st) o.strategy = st;
  if (md) o.model = md;
  return o;
};

async function main() {
  const cmd = args.shift() || 'list';
  switch (cmd) {
    case 'list': case 'ls': {
      await A.refreshUsage({ force: flag('--refresh') }).catch(() => undefined);
      const s = A.snapshot();
      return out(s, render(s));
    }
    case 'status': {
      const s = A.snapshot();
      const a = s.accounts.find((x) => x.active);
      const login = A.liveLoginWhere();
      return out({ active: a || null, unmanagedLive: s.unmanagedLive, login }, `${a ? `#${a.slot} ${a.email}${a.alias ? ` (${a.alias})` : ''}` : s.unmanagedLive ? `${s.unmanagedLive} (not stored)` : 'not logged in'}\nlogin store: ${login}`);
    }
    case 'pool': {
      await A.refreshUsage().catch(() => undefined);
      const s = A.snapshot();
      const a = s.accounts.find((x) => x.active);
      return console.log(JSON.stringify({ pool: s.pool, count: s.accounts.length, active: a ? { slot: a.slot, fiveHour: a.usage?.fiveHour?.pct ?? null, sevenDay: a.usage?.sevenDay?.pct ?? null } : null, auto: s.config.auto.enabled }));
    }
    case 'add': {
      const r = await A.addAccount({ slot: opt('--slot'), alias: opt('--alias') });
      const n = A.snapshot().accounts.length;
      const autoHint = n >= 2 && !A.loadConfig().auto.enabled
        ? `\n\nAuto-switch is OFF. With it on, multiclaude switches the default login (every running Claude Code session follows it) when the active account reaches 90%. Turn it on:  accounts config set auto.enabled true`
        : '';
      return out(r, `${r.updated ? 'Updated' : 'Stored'} account #${r.slot} (${r.email}). To add another: log in with it in Claude Code (/login — no /logout first), then run accounts add again.${autoHint}`);
    }
    case 'remove': case 'rm': {
      const r = await A.removeAccount(args[0]);
      return out(r, `Removed #${r.slot} (${r.email}). The live login is untouched.`);
    }
    case 'switch': {
      let id = args[0];
      if (!id) {
        await A.refreshUsage().catch(() => undefined);
        const s = A.snapshot();
        const usable = s.accounts.filter((a) => !a.disabled && !a.dead && !a.session.length);
        if (!usable.length) throw new Error('no usable account to switch to');
        const i = usable.findIndex((a) => a.active);
        id = usable[(i + 1) % usable.length].slot;
      }
      const r = await A.switchTo(id, { reason: 'manual', force: flag('--force') });
      return out(r, r.noop ? `Already on #${r.to} (${r.email}).` : `Switched to #${r.to} (${r.email})${r.from ? `; #${r.from}'s current token was saved` : ''}. Running Claude Code picks it up on its next credential read; restart it to apply at once.`);
    }
    case 'alias': {
      const r = await A.setMeta(args[0], { alias: flag('--unset') ? '' : args[1] || '' });
      return out(r, r.alias ? `#${r.slot} alias: ${r.alias}` : `#${r.slot}: alias cleared`);
    }
    case 'disable': case 'enable': {
      const r = await A.setMeta(args[0], { disabled: cmd === 'disable' });
      return out(r, `#${r.slot} (${r.email}) ${cmd}d for auto-switch and rotation${cmd === 'disable' ? '; an explicit `accounts switch` still works' : ''}.`);
    }
    case 'threshold': {
      if (!args[0]) { const s = A.snapshot(); return out(s.accounts.map((a) => ({ slot: a.slot, threshold: a.threshold })), [`default: ${s.config.auto.threshold}%`, ...s.accounts.filter((a) => a.threshold != null).map((a) => `#${a.slot} ${a.email}: ${a.threshold}%`)].join('\n')); }
      const r = await A.setMeta(args[0], { threshold: flag('--unset') ? null : Number(args[1]) });
      return out(r, `#${r.slot} switch-away line: ${r.threshold ?? 'default'}`);
    }
    case 'config': {
      if (args[0] === 'set') { const c = A.setConfig(args[1], args[2] ?? ''); return out(c, JSON.stringify(c, null, 2)); }
      const c = A.loadConfig(); return out(c, JSON.stringify(c, null, 2));
    }
    case 'auto': {
      const once = flag('--once'), dryRun = flag('--dry-run');
      const interval = Number(opt('--interval') || 60);
      const o = autoOverrides();
      const step = async () => {
        const cfg = A.loadConfig().auto;
        if (!cfg.enabled && !dryRun) return { action: 'hold', reason: 'auto-switch disabled (accounts config set auto.enabled true)' };
        return A.autoOnce({ dryRun, cfgOverride: o });
      };
      const show = (r) => out({ at: new Date().toISOString(), ...r }, `${new Date().toLocaleTimeString()} ${r.action}${r.to ? ` → #${r.to}` : ''}${r.dryRun ? ' (dry run)' : ''}: ${r.reason}`);
      if (once) { const r = await step(); show(r); process.exitCode = r.action === 'switch' ? 0 : r.action === 'blocked' ? 3 : 2; return; }
      for (;;) { try { show(await step()); } catch (e) { out({ action: 'error', reason: e.message }, `error: ${e.message}`); } await new Promise((r) => setTimeout(r, interval * 1000)); }
    }
    case 'run': {
      const shareHistory = flag('--share-history') || (A.loadConfig().run.shareHistory && !flag('--no-share-history'));
      const r = await A.prepareSession(args[0], { shareHistory });
      const claude = which('claude') || 'claude';
      for (const n of r.notes || []) console.error(`note: ${n}`);
      const env = { ...process.env };
      if (r.plain) {
        console.error(`#${r.slot} (${r.email}) is the default login — starting plain claude.`);
      } else {
        env.CLAUDE_CONFIG_DIR = r.dir;
        console.error(`claude as #${r.slot} (${r.email}) — this terminal only; profile ${r.dir}${r.busy ? ' (another session of this account is running)' : ''}`);
        A.markSession(r.slot, process.pid);
      }
      const child = spawn(claude, passthru, { stdio: 'inherit', env, shell: process.platform === 'win32' });
      for (const sig of ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { /* the child owns the terminal */ });
      const code = await new Promise((res) => child.on('exit', (c, s) => res(c ?? (s ? 128 : 1))).on('error', (e) => { console.error(`cannot start claude: ${e.message}`); res(1); }));
      if (!r.plain) { const adopted = await A.endSession(r.slot, process.pid).catch(() => false); if (adopted) console.error(`#${r.slot}: the session's refreshed token was saved to the store.`); }
      process.exit(code);
    }
    default:
      throw Object.assign(new Error(`unknown command "${cmd}" — try: list | add | switch | auto | run | remove | alias | disable | enable | threshold | config`), { usage: true });
  }
}

main().catch((e) => {
  if (json) console.log(JSON.stringify({ action: 'error', error: e.message }));
  else console.error(`accounts: ${e.message}`);
  process.exit(1);
});
