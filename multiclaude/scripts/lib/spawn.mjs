// multiclaude: start a resolved CLI without a shell, on every OS.
//
// On Windows, npm installs CLIs as .cmd shims (codex.cmd), and Node refuses to spawn a
// .cmd/.bat without a shell since 18.20.2 / 20.12.2 (CVE-2024-27980: `spawn EINVAL`). A shell
// would need cmd.exe quoting of every argument, so run what the shim runs instead: node with
// the package's bin script (the prompt still rides stdin). Pure Node.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// The script an npm cmd-shim starts: "%dp0%\node_modules\@openai\codex\bin\codex.js" (npm 7+)
// or "%~dp0\node_modules\…\cli.js" (older npm).
const SHIM_TARGET = /"%~?dp0%?\\([^"%]+?\.[cm]?js)"/i;

/**
 * [command, args] for spawn(): `bin` and `args` unchanged, except a Windows npm .cmd/.bat shim,
 * which becomes node (a node.exe beside the shim, as the shim itself prefers, else this one)
 * plus its script. An unrecognized shim comes back unchanged (spawn then fails with EINVAL).
 */
export function spawnable(bin, args = [], { win = process.platform === 'win32', node = process.execPath } = {}) {
  if (!win || !/\.(cmd|bat)$/i.test(bin)) return [bin, args];
  let text;
  try { text = readFileSync(bin, 'utf8'); } catch { return [bin, args]; }
  const m = SHIM_TARGET.exec(text);
  if (!m) return [bin, args];
  const dir = path.dirname(bin);
  const script = path.join(dir, ...m[1].split(/[\\/]+/).filter(Boolean));
  if (!existsSync(script)) return [bin, args];
  const local = path.join(dir, 'node.exe');
  return [existsSync(local) ? local : node, [script, ...args]];
}
