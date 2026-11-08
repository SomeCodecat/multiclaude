#!/usr/bin/env node
// herdr-activity — the publisher half of the herdr-mascots companion (docs/herdr-mascots.md).
// The hooks module builds the activity document; this script only switches the companion
// on / off and hands the document to herdr-core (`hc connect`, JSON-RPC doc.get / doc.set).
//
//   herdr-activity.mjs --enabled        `on` when the companion is on AND this runs inside herdr
//                                       with an HC_TERMINAL_ID, else `off` (the module asks)
//   herdr-activity.mjs status [--json]  the companion's state (setup.mjs companions reads it)
//   herdr-activity.mjs enable|disable   write / remove the on-flag (setup companions add|remove)
//   herdr-activity.mjs set              stdin = the document JSON (`null` deletes it); written
//                                       as mc-activity-<HC_TERMINAL_ID>, version-checked
//
// The flag lives in <config>/multiclaude/herdr-mascots.on (XDG_CONFIG_HOME or ~/.config;
// %APPDATA% on Windows). Off by default: the companion surfaces UI in herdr.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { which, inHerdr, herdrMascotsFlag } from './lib/mc.mjs';

const FLAG = herdrMascotsFlag();
const CONFIG_DIR = path.dirname(FLAG);

const terminal = () => {
  const id = process.env.HC_TERMINAL_ID || '';
  return /^[\w.-]+$/.test(id) ? id : '';
};
const hcBin = () => which('hc') || which('herdr-core');

// One `hc connect` session: send each request as a JSON-RPC line, read the reply by id.
function hcSession() {
  const bin = hcBin();
  if (!bin) throw new Error('hc (herdr-core) not found on PATH');
  const child = spawn(bin, ['connect'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const waiting = new Map();
  let buf = '', nextId = 1, dead = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const fail = (why) => { dead = why; for (const w of waiting.values()) w({ error: { message: why } }); waiting.clear(); };
  child.on('error', (e) => fail(e.message));
  child.on('close', () => fail('hc connect closed'));
  const call = (method, params) => new Promise((resolve) => {
    if (dead) return resolve({ error: { message: dead } });
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, close: () => { try { child.stdin.end(); } catch { /* gone */ } setTimeout(() => child.kill(), 500).unref(); } };
}

async function setDoc(name, value) {
  const hc = hcSession();
  const timer = setTimeout(() => { console.error('herdr-activity: hc did not answer'); process.exit(1); }, 8000);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const got = await hc.call('doc.get', { name });
      if (got.error) throw new Error(got.error.message || 'doc.get failed');
      if (value === null && got.result?.value == null) return got.result?.version ?? 0;   // nothing to delete
      const put = await hc.call('doc.set', { name, value, version: got.result?.version ?? 0 });
      if (!put.error) return put.result?.version;
      if (put.error.data?.kind !== 'conflict' && !/version/i.test(put.error.message || '')) throw new Error(put.error.message || 'doc.set failed');
    }
    throw new Error('doc.set kept losing the version race');
  } finally { clearTimeout(timer); hc.close(); }
}

const readStdin = () => new Promise((resolve) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { s += d; });
  process.stdin.on('end', () => resolve(s));
});

const args = process.argv.slice(2);
const cmd = args[0] || '';
const on = () => existsSync(FLAG);

if (cmd === '--enabled') {
  console.log(on() && inHerdr() && terminal() ? 'on' : 'off');
} else if (cmd === 'status') {
  const s = { enabled: on(), inHerdr: inHerdr(), terminal: terminal() || null, hc: !!hcBin(), flag: FLAG };
  if (args.includes('--json')) console.log(JSON.stringify(s));
  else console.log(`herdr-mascots ${s.enabled ? 'on' : 'off'} · ${s.inHerdr ? `inside herdr (${s.terminal || 'no terminal id'})` : 'not inside herdr'} · hc ${s.hc ? 'found' : 'missing'}`);
} else if (cmd === 'enable') {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(FLAG, `on since ${new Date().toISOString()}\n`);
  console.log(`  + herdr-mascots on (${FLAG}) — sessions inside herdr publish mc-activity-<terminal>; the herdr-app mod draws them (docs/herdr-mascots.md)`);
  if (!hcBin()) console.log('  ! hc (herdr-core) is not on PATH here — nothing is published until it is');
} else if (cmd === 'disable') {
  rmSync(FLAG, { force: true });
  console.log('  - herdr-mascots off — running sessions clear their mascots within a minute');
} else if (cmd === 'set') {
  const id = terminal();
  if (!id) { console.error('herdr-activity: no HC_TERMINAL_ID — not inside herdr'); process.exit(2); }
  let value;
  try { value = JSON.parse((await readStdin()) || 'null'); } catch { console.error('herdr-activity: stdin is not JSON'); process.exit(2); }
  if (value && typeof value === 'object' && !Array.isArray(value)) value.terminal = id;   // the module does not know its terminal id
  try {
    const v = await setDoc(`mc-activity-${id}`, value);
    console.log(String(v ?? ''));
  } catch (e) { console.error(`herdr-activity: ${e.message}`); process.exit(1); }
} else {
  console.error('usage: herdr-activity.mjs --enabled | status [--json] | enable | disable | set  (stdin: JSON)');
  process.exit(2);
}
