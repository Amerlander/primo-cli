import { resolve_dev_server } from '../utils/dev-runtime.js'
import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import { read_site_config, SITE_CONFIG_FILE } from '../utils/site-config.js'
import { read_server_config, SERVER_CONFIG_FILE } from '../utils/server-config.js'

interface StatusOptions {
	dir: string
	json?: boolean
}

interface SiteSync {
	ok: boolean
	error?: string
	failed_at?: string
	warnings?: number
	warned_at?: string
	last_import_at?: string
}

interface SiteStatus {
	slug: string
	name: string | null
	site_id: string | null
	group: string | null
	sync: SiteSync | null
	/** Whether the site exists in the running CMS. null when the server is down. */
	in_cms: boolean | null
}

/**
 * Report the local workspace without needing the CMS API (which is
 * auth-gated): server liveness comes from a health probe, and everything else
 * is read from the files an agent can already see — `server.yaml`,
 * `sites/<slug>/site.yaml`, and each site's `.primo/sync_status.json`.
 */
export async function status(options: StatusOptions) {
	const base_dir = path.resolve(options.dir)
	const as_json = !!options.json

	try {
		await fs.access(path.join(base_dir, SERVER_CONFIG_FILE))
	} catch {
		const message = "No " + SERVER_CONFIG_FILE + " found in " + base_dir + ". Run 'primo status' from a workspace root, or pass --dir <workspace>."
		if (as_json) {
			console.log(JSON.stringify({ error: message }, null, 2))
		} else {
			console.log(chalk.red(message))
		}
		process.exitCode = 1
		return
	}

	const server_config = await read_server_config(base_dir)
	const { port, url: api_url, running } = await resolve_dev_server(base_dir, server_config.port)
	const sites = await read_sites(base_dir)

	// When the server is up, its dev-auth token unlocks the authoritative CMS
	// state — the collections API is otherwise auth-gated and returns empty.
	const cms = running ? await read_live_cms(api_url) : null
	if (cms) {
		const known = new Set(cms.sites.map((site) => site.id))
		for (const site of sites) {
			site.in_cms = site.site_id ? known.has(site.site_id) : false
		}
	}

	if (as_json) {
		console.log(JSON.stringify({
			workspace: base_dir,
			port,
			running,
			groups: server_config.site_groups ?? [],
			sites,
			...(cms ? { cms } : {})
		}, null, 2))
		return
	}

	console.log(chalk.bold('\nPrimo workspace'))
	console.log(`  ${chalk.dim('path')}    ${base_dir}`)
	console.log(`  ${chalk.dim('server')}  ${running ? chalk.green(`running on port ${port}`) : chalk.yellow(`not running (port ${port})`)}`)
	console.log(`  ${chalk.dim('groups')}  ${(server_config.site_groups ?? []).length}`)
	console.log(`  ${chalk.dim('sites')}   ${sites.length}`)
	if (cms) {
		console.log(`  ${chalk.dim('cms')}     ${cms.sites.length} site record${cms.sites.length === 1 ? '' : 's'}, ${cms.groups.length} group${cms.groups.length === 1 ? '' : 's'}`)
	}

	const failed = sites.filter((site) => site.sync && !site.sync.ok)
	if (failed.length > 0) {
		console.log('')
		console.log(chalk.red(`  ${failed.length} site${failed.length === 1 ? '' : 's'} with a failed last import:`))
		for (const site of failed) {
			console.log(`    ${chalk.red('✖')} ${site.slug}  ${chalk.dim(site.sync?.error ?? 'last import failed')}`)
		}
	}

	const missing = sites.filter((site) => site.in_cms === false)
	if (missing.length > 0) {
		console.log('')
		console.log(chalk.yellow(`  ${missing.length} site${missing.length === 1 ? '' : 's'} on disk but not registered in the CMS:`))
		for (const site of missing) {
			console.log(`    ${chalk.yellow('!')} ${site.slug}  ${chalk.dim('run `primo add ' + site.slug + '`')}`)
		}
	}
	console.log('')
}

async function read_sites(base_dir: string): Promise<SiteStatus[]> {
	const sites_dir = path.join(base_dir, 'sites')
	let entries: string[]
	try {
		entries = await fs.readdir(sites_dir)
	} catch {
		return []
	}

	const sites: SiteStatus[] = []
	for (const slug of entries.sort()) {
		if (slug.startsWith('.')) continue

		const site_dir = path.join(sites_dir, slug)
		const dir_stat = await fs.stat(site_dir).catch(() => null)
		if (!dir_stat?.isDirectory()) continue

		// A folder only counts as a site once it has a site.yaml.
		const has_config = await fs.access(path.join(site_dir, SITE_CONFIG_FILE)).then(() => true).catch(() => false)
		if (!has_config) continue

		let config: Record<string, unknown> | null = null
		try {
			config = (await read_site_config(site_dir)) as unknown as Record<string, unknown> | null
		} catch {
			// Malformed site.yaml — still report the folder, with nulls.
		}

		const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null)
		sites.push({
			slug,
			name: str(config?.name),
			site_id: str(config?.site_id),
			group: str(config?.group),
			sync: await read_sync(site_dir),
			in_cms: null
		})
	}

	return sites
}

async function read_sync(site_dir: string): Promise<SiteSync | null> {
	try {
		const raw = await fs.readFile(path.join(site_dir, '.primo', 'sync_status.json'), 'utf-8')
		const parsed = JSON.parse(raw) as Record<string, unknown>
		const sync: SiteSync = { ok: parsed.ok === true }
		if (typeof parsed.error === 'string') sync.error = parsed.error
		if (typeof parsed.failed_at === 'string') sync.failed_at = parsed.failed_at
		if (typeof parsed.warnings === 'number') sync.warnings = parsed.warnings
		if (typeof parsed.warned_at === 'string') sync.warned_at = parsed.warned_at
		if (typeof parsed.last_import_at === 'string') sync.last_import_at = parsed.last_import_at
		return sync
	} catch {
		return null
	}
}

interface CmsSite {
	id: string
	name?: string
	group?: string
}

interface CmsGroup {
	id: string
	name?: string
}

/**
 * Read the running server's authoritative state. The collections API is
 * auth-gated, so this first exchanges the local dev-auth endpoint for a token —
 * the same route the MCP `build_preview` uses. Returns null when the server
 * can't be reached or doesn't grant a token.
 */
async function read_live_cms(api_url: string): Promise<{ sites: CmsSite[]; groups: CmsGroup[] } | null> {
	try {
		const auth = await fetch(`${api_url}/api/primo/dev-auth`, {
			method: 'POST',
			signal: AbortSignal.timeout(1500)
		})
		if (!auth.ok) return null
		const { token } = (await auth.json()) as { token?: string }
		if (!token) return null

		const headers = { Authorization: token }
		const [sites_response, groups_response] = await Promise.all([
			fetch(`${api_url}/api/collections/sites/records?perPage=200`, { headers }),
			fetch(`${api_url}/api/collections/site_groups/records?perPage=200`, { headers })
		])
		const sites = sites_response.ok
			? ((await sites_response.json()) as { items?: CmsSite[] }).items ?? []
			: []
		const groups = groups_response.ok
			? ((await groups_response.json()) as { items?: CmsGroup[] }).items ?? []
			: []
		return { sites, groups }
	} catch {
		return null
	}
}
