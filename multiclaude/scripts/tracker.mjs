#!/usr/bin/env node
// multiclaude usage tracker — /multiclaude:usage and the Wallets pane's usage section.
//
//   tracker.mjs [today|7d|30d|all] [--json] [--no-scan] [--refresh-prices]
//
// Scans what the CLIs recorded since the last scan (incremental; the first scan
// reads the whole history and can take a minute), then reports tokens in / out
// (combined and split, cache reads/writes shown apart) and ≈ API list-price spend
// per wallet, per account and per model. Spend is what the same tokens would cost
// at API list prices (LiteLLM table): subscriptions are not billed per token.
import { scan, readState, report, PERIODS } from './lib/tracker.mjs';
import { refreshPrices, OVERRIDES } from './lib/prices.mjs';

const argv = process.argv.slice(2);
let since = '7d', json = false, doScan = true, forcePrices = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a in PERIODS) since = a;
  else if (a === '--since') since = argv[++i] || since;
  else if (a === '--json') json = true;
  else if (a === '--no-scan') doScan = false;
  else if (a === '--refresh-prices') forcePrices = true;
  else { process.stderr.write(`tracker: unknown argument ${a}\nusage: tracker.mjs [today|7d|30d|all] [--json] [--no-scan] [--refresh-prices]\n`); process.exit(2); }
}
if (!(since in PERIODS)) { process.stderr.write('tracker: period is today, 7d, 30d or all\n'); process.exit(2); }

const priced = await refreshPrices({ force: forcePrices });
const s = doScan ? scan() : { state: readState() };
const r = report(s.state, { since });
if (json) {
  process.stdout.write(JSON.stringify({ ...r, scan: { counted: s.counted ?? null, ms: s.ms ?? null, skipped: s.skipped ?? null }, prices: priced.ok ? null : priced.msg }) + '\n');
  process.exit(0);
}

const k = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
const usd = (row) => (row.usd > 0 || !row.unpriced ? '$' + (row.usd >= 100 ? row.usd.toFixed(0) : row.usd.toFixed(2)) : '–') + (row.usd > 0 && row.unpriced ? '+' : '');
const pad = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t).padEnd(n);
const lpad = (t, n) => t.padStart(n);
const head = `${pad('', 34)}${lpad('input', 9)}${lpad('cached', 9)}${lpad('output', 9)}${lpad('total', 9)}${lpad('≈ API $', 10)}`;
const row = (name, x) => `${pad(name, 34)}${lpad(k(x.input), 9)}${lpad(k(x.cacheRead + (x.cacheWrite || 0) + (x.cacheWrite1h || 0)), 9)}${lpad(k(x.out), 9)}${lpad(k(x.total), 9)}${lpad(usd(x), 10)}`;
const when = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : 'never');

const out = [];
out.push(`[multiclaude usage] ${since === 'all' ? `all recorded history (since ${r.firstDay ?? '—'})` : since === 'today' ? 'today' : `last ${since} (from ${r.from})`} · scanned ${when(r.scannedAt)}${s.ms != null ? ` in ${(s.ms / 1000).toFixed(1)}s` : ''}${s.skipped ? ` (${s.skipped})` : ''}`);
out.push(`  input = fresh + cached (cache reads and writes; "cached" shows that part) · ≈ API $ = API list price of the same tokens, not a bill`);
out.push('', head, row('ALL', r.totals), '');
out.push('By wallet'); for (const w of r.wallets) out.push(row('  ' + w.wallet, w));
out.push('', 'By account'); for (const a of r.accounts) out.push(row(`  ${a.wallet} ${a.label}`, a));
out.push('', 'By model'); for (const m of r.models.slice(0, 25)) out.push(row(`  ${m.model}${m.priced ? '' : ' (no price)'}`, m));
if (r.models.length > 25) out.push(`  … ${r.models.length - 25} more (--json)`);
const unp = r.models.filter(m => !m.priced).map(m => m.model);
if (unp.length) out.push('', `No price for: ${unp.join(', ')} — add USD per million tokens to ${OVERRIDES}, e.g. {"${unp[0]}": {"in": 1, "out": 5}}`);
if (!priced.ok) out.push(`(${priced.msg}; using the cached price table)`);
if (r.accounts.some(a => a.wallet === 'claude' && a.account === '?')) out.push('', 'Claude "unattributed": default-profile history from before the first known switch point; account switches are logged from now on.');
out.push('AGY counts runs made through dispatch.mjs only.');
if (r.wallets.some(w => w.wallet === 'pi')) out.push(`pi counts runs made through dispatch.mjs only; a pi model with no price in ${OVERRIDES} shows the cost its own gateway reported.`);
process.stdout.write(out.join('\n') + '\n');
