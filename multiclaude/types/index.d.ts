// Type contract for the multiclaude hooks module (hooks/register.tsx): the
// values it keeps in `$.state`, declared under the plugin's name.
export type Job = {
  id: string
  delegate: 'agy' | 'codex'
  model: string
  effort?: string
  label: string
  startedAt: number
  endedAt?: number
  status: 'queued' | 'running' | 'done' | 'denied' | 'failed' | 'timeout' | 'usage' | 'cancelled'
  /** The latest progress line the runner printed (one per delegate step). */
  step: string
  /** The runner's final proof line: `[dispatch agy model=… status=… tokens=… out=…]`. */
  proof: string
  /** Where the runner wrote the full answer (from the proof line's out=…). */
  outFile?: string
  /** 'tool' = started by the dispatch tool; 'runner' = folded in from a <id>.json the runner wrote (Bash / workflow / forwarder). */
  source?: 'tool' | 'runner'
}

declare module 'claude-code' {
  interface PluginState {
    multiclaude: { jobs: Shaped<Job[]> }
  }
}
