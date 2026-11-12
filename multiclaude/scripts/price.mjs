#!/usr/bin/env node
// multiclaude price — tokens and ≈ API list-price spend of Claude transcripts, as JSON.
//
//   price.mjs <transcript.jsonl> [more.jsonl …]
//   price.mjs --usage '<json>'
//
// For a caller that wants a dollar figure beside one agent (a Claude subagent's
// `agent-*.jsonl`, or a whole session file): prints one JSON array, one entry per file in
// the order given —
//   { file, usd, unpriced, calls, in, cacheRead, cacheWrite, out, total, model,
//     models: [{ model, usd, in, cacheRead, cacheWrite, out, calls }] }
// `usd` is null when no model in the file has a price (`unpriced` = those in + out tokens);
// an unreadable file gives { file, error }.
//
// --usage prices token counts the caller already holds, with no transcript: one record or
// an array of { model, input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens } (the API's usage fields, as a turn reports them) → one
// { model, usd, in, cacheRead, cacheWrite, out, total } per record, `usd` null when the
// model has no price. The hooks module prices a Claude subagent's turn with it.
//
// Local files and the cached price table only: no network, nothing written. "≈ API $" is a
// comparison figure, never a bill.
import { priceTranscripts } from './lib/tracker.mjs';
import { loadPrices, costOf } from './lib/prices.mjs';

const argv = process.argv.slice(2);
const usage = () => { process.stderr.write('usage: price.mjs <transcript.jsonl> [more.jsonl …]\n       price.mjs --usage \'<json>\'\n'); process.exit(2); };

const at = argv.indexOf('--usage');
if (at >= 0) {
  let recs;
  try { recs = JSON.parse(argv[at + 1] ?? ''); } catch { usage(); }
  if (!recs || typeof recs !== 'object') usage();
  const prices = loadPrices();
  const n = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
  const out = (Array.isArray(recs) ? recs : [recs]).map((r) => {
    const u = { in: n(r?.input_tokens), cacheRead: n(r?.cache_read_input_tokens), cacheWrite: n(r?.cache_creation_input_tokens), out: n(r?.output_tokens) };
    const model = typeof r?.model === 'string' ? r.model : null;
    const c = model ? costOf(prices.lookup(model), u) : null;
    return { model, usd: c == null ? null : +c.toFixed(6), ...u, total: u.in + u.cacheRead + u.cacheWrite + u.out };
  });
  process.stdout.write(JSON.stringify(out) + '\n');
} else {
  const files = argv.filter((a) => !a.startsWith('--'));
  if (!files.length) usage();
  process.stdout.write(JSON.stringify(priceTranscripts(files)) + '\n');
}
