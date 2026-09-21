/**
 * tool-scope — shrink THIS agent's visible tool surface, for the opt-in "lean" preset.
 *
 * WHY A PRESET MODULE AND NOT A CONFIG FLAG: most of the tools this preset wants gone
 * come from the HOST composition (the profile's plugin set), not from a row in this
 * preset file — so they cannot be unmounted from here. The one seam that removes an
 * inherited tool from the model-visible surface is the scoped registry restriction
 * `agent.ctx.tools.restrict({ deny })`, which returns the disposer that lifts it.
 * That seam was verified against the installed runtime in ticket #14
 * (harness/research/04-dynamic-visibility.md).
 *
 * WHY `agent/created`: the restriction must be installed OUTSIDE the system-prompt
 * assembly waterfall. `SystemPrompt.assemble()` renders the `tools:sdk` section from
 * the registry before the assembly waterfall runs, so a restriction installed inside
 * that waterfall would only change the NEXT request's prompt. Installing at scope
 * creation is what makes the first request already render the narrowed SDK block.
 *
 * WHAT IT WILL NOT DO: `restrict` filters the INHERITED surface and exempts this
 * layer's own registrations (verified in #14), so a tool this preset itself registers
 * may survive the deny list. That is why the projection in harness/preset/README.md
 * separates the host-plane families (certain) from the preset-owned ones (best effort).
 *
 * COST OF BEING WRONG: none to the loop — `run_code` and the core file/shell tools are
 * on the never-deny list, and a denied family is only unreachable, never half-mounted.
 */

export const name = 'lean-tool-scope'

/** Families removed by default. Prefix match against the live scoped surface. */
export const DENY_PREFIXES = ['mcp__', 'ssh_', 'team_task_', 'job_', 'spawn_teammate']

/** Exact names removed by default. */
export const DENY_EXACT = ['create_goal', 'get_goal', 'update_goal', 'consult_expert']

/** Tools that must survive any deny list: the PTC transport and the loop's own basics. */
export const NEVER_DENY = [
  'run_code',
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh',
  'ask_user_question', 'todo_write', 'present',
  'web_search', 'web_fetch', 'subagent', 'subagent_fork',
]

/**
 * Pure selection step, exported so it can be unit-tested without a host:
 * given the live tool names, return the ones this preset asks to remove.
 */
export function selectDenied(names, prefixes = DENY_PREFIXES, exact = DENY_EXACT, keep = NEVER_DENY) {
  const out = []
  for (const n of Array.isArray(names) ? names : []) {
    if (typeof n !== 'string' || n.length === 0) continue
    if (keep.includes(n)) continue
    if (exact.includes(n) || prefixes.some((p) => n.startsWith(p))) out.push(n)
  }
  return out
}

/** Read the agent's visible tool names from whichever public accessor this runtime exposes. */
function visibleNames(tools, agent) {
  const views = []
  for (const method of ['schemas', 'sdkSchemas']) {
    if (typeof tools[method] !== 'function') continue
    try {
      const v = tools[method](agent)
      if (Array.isArray(v) && v.length > 0) views.push(v)
    } catch {
      // A sync may run before the registry is populated; not fatal.
    }
  }
  for (const view of views) {
    const names = view.map((s) => (s && typeof s.name === 'string' ? s.name : undefined)).filter(Boolean)
    if (names.length > 0) return names
  }
  return []
}

export function apply(ctx, config) {
  const prefixes = Array.isArray(config?.denyPrefixes) ? config.denyPrefixes : DENY_PREFIXES
  const exact = Array.isArray(config?.denyExact) ? config.denyExact : DENY_EXACT
  const keep = Array.isArray(config?.neverDeny) ? config.neverDeny : NEVER_DENY

  const disposers = new WeakMap()
  const warned = new Set()
  const warnOnce = (key, detail) => {
    if (warned.has(key)) return
    warned.add(key)
    try { ctx.logger?.warn?.(`${name}: ${detail}`) } catch { /* logger unavailable */ }
  }

  const release = (agent) => {
    const dispose = disposers.get(agent)
    if (dispose === undefined) return
    disposers.delete(agent)
    try { dispose() } catch (err) {
      warnOnce('release', `lifting the tool restriction failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const install = (agent) => {
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') {
      warnOnce('no-scoped-view', 'this scope exposes no tools.restrict() — the lean surface was NOT applied')
      return
    }
    const names = visibleNames(tools, agent)
    if (names.length === 0) {
      warnOnce('empty-surface', 'the scoped tool surface read back empty — nothing to narrow for this scope')
      return
    }
    release(agent)
    const deny = selectDenied(names, prefixes, exact, keep)
    if (deny.length === 0) return
    let dispose
    try {
      dispose = tools.restrict({ deny })
    } catch (err) {
      warnOnce('restrict-failed', `tools.restrict() threw: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (typeof dispose !== 'function') {
      warnOnce('restrict-unconfirmed', 'the registry did not confirm the restriction — the lean surface was NOT applied')
      return
    }
    disposers.set(agent, dispose)
    try {
      ctx.logger?.info?.(`${name}: withheld ${deny.length} of ${names.length} tools from this scope`)
    } catch { /* logger unavailable */ }
  }

  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => release(agent))
}
