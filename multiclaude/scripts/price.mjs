#!/usr/bin/env node
// multiclaude price — tokens and ≈ API list-price spend of Claude transcripts, as JSON.
//
//   price.mjs <transcript.jsonl> [more.jsonl …]
//
// For a caller that wants a dollar figure beside one agent (a Claude subagent's
// `agent-*.jsonl`, or a whole session file): prints one JSON array, one entry per file in
// the order given —
//   { file, usd, unpriced, calls, in, cacheRead, cacheWrite, out, total, model,
//     models: [{ model, usd, in, cacheRead, cacheWrite, out, calls }] }
// `usd` is null when no model in the file has a price (`unpriced` = those in + out tokens);
// an unreadable file gives { file, error }. Local files and the cached price table only:
// no network, nothing written. "≈ API $" is a comparison figure, never a bill.
import { priceTranscripts } from './lib/tracker.mjs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) { process.stderr.write('usage: price.mjs <transcript.jsonl> [more.jsonl …]\n'); process.exit(2); }
process.stdout.write(JSON.stringify(priceTranscripts(files)) + '\n');
