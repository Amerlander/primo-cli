import fs from 'fs/promises'
import path from 'path'
import { get_auth_token } from './auth.js'
import { inspect_push_target, type PushTarget } from './push-guard.js'
import { normalize_server_url } from './server-config.js'
import type { SiteConfig } from './site-config.js'

interface FailureGroup {
	server: string
	reason: string
	targets: PushTarget[]
}

// Advisory only: no login prompt, pull, or baseline write. All requests share
// one deadline so an offline server doesn't delay startup once per site.
export async function check_dev_remote_changes(
	root: string,
	sites: { dir: string; config: SiteConfig }[],
	workspace_server?: string,
	include_library = false,
	timeout_ms = 5000
): Promise<string[]> {
	const targets: PushTarget[] = []
	for (const site of sites) {
		// Match push's workspace default, which takes precedence over site.yaml.
		const server = workspace_server || site.config.server
		if (!server || !site.config.site_id) continue
		targets.push({ dir: site.dir, target: site.config.site_id,
			server: normalize_server_url(server), label: site.config.name || path.basename(site.dir) })
	}
	const library_server = workspace_server || targets[0]?.server
	if (include_library && library_server && await fs.access(path.join(root, 'library')).then(() => true, () => false)) {
		targets.push({ dir: root, target: 'library', server: normalize_server_url(library_server), label: 'Shared library' })
	}
	if (!targets.length) return []
	const signal = AbortSignal.timeout(timeout_ms)
	const results = await Promise.all(targets.map(async target => {
		try {
			target.token = await get_auth_token(target.server)
			const state = await inspect_push_target(target, signal)
			if (!state.stale) return null
			return state.has_baseline
				? `${target.label}: changed on ${target.server} since the last sync (or was deleted). Save any local work, then pull before editing.`
				: `${target.label}: no saved sync history for ${target.server}; server freshness is unknown. Save any local work before pulling.`
		} catch (error) {
			const reason = signal.aborted ? 'check timed out' : error instanceof Error ? error.message : String(error)
			return { target, reason }
		}
	}))
	// Keep actionable per-target notices, but report repeated check failures
	// once per server and reason, in the order they first appeared.
	const notices: (string | FailureGroup)[] = []
	const failures = new Map<string, FailureGroup>()
	for (const result of results) {
		if (result === null) continue
		if (typeof result === 'string') {
			notices.push(result)
			continue
		}
		const { target, reason } = result
		const key = JSON.stringify([target.server, reason])
		let group = failures.get(key)
		if (!group) {
			group = { server: target.server, reason, targets: [] }
			failures.set(key, group)
			notices.push(group)
		}
		group.targets.push(target)
	}
	return notices.map(notice => {
		if (typeof notice === 'string') return notice
		const { server, reason, targets } = notice
		if (targets.length === 1) {
			return `${targets[0].label}: could not check ${server} (${reason}). Server freshness is unknown.`
		}
		const library = targets.some(target => target.target === 'library')
		const sites = targets.length - Number(library)
		const scope = `${sites} site${sites === 1 ? '' : 's'}${library ? ' and the shared library' : ''}`
		return `${server}: could not check ${scope} (${reason}). Server freshness is unknown.`
	})
}
