import { find_dev_workspace, resolve_dev_server } from '../utils/dev-runtime.js'
import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import extract from 'extract-zip'
import { dump as dump_yaml, load as load_yaml } from 'js-yaml'
import { get_auth_token } from '../utils/auth.js'
import { authenticate_interactively } from './login.js'
import { write_site_config } from '../utils/site-config.js'
import { read_server_config, write_server_config, normalize_server_url, type ServerConfig, type SiteGroupConfig } from '../utils/server-config.js'
import { generate_agent_md } from './new.js'

interface PullOptions {
	server?: string
	output?: string
	token?: string
}

// Directories owned by the server export. Local files under these that no
// longer exist in the export are stale (e.g. a page that gained children
// moved from pages/foo.yaml to pages/foo/index.yaml) and get trashed.
const MANAGED_DIRS = ['pages', 'blocks', 'page-types', 'site']

async function detect_server(): Promise<string | null> {
	const workspace = await find_dev_workspace(process.cwd())
	if (workspace) {
		const config = await read_server_config(workspace)
		const server = await resolve_dev_server(workspace, config.port)
		if (!server.running) throw new Error(`No running Primo server for this workspace. Start primo dev, or pass --server <url>.`)
		return server.url
	}
	const ports = [3000, 8080, 5173]

	for (const port of ports) {
		try {
			const url = `http://127.0.0.1:${port}`
			const response = await fetch(`${url}/api/health`, {
				signal: AbortSignal.timeout(500)
			})
			if (response.ok) {
				return url
			}
		} catch {
			// Not running on this port
		}
	}

	return null
}

interface Site {
	id: string
	name: string
	host: string
	group: string
}

interface SiteGroup {
	id: string
	name: string
	index?: number
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site'
}

function server_folder_name(server: string): string {
	try {
		return new URL(server).hostname || 'primo-server'
	} catch {
		return 'primo-server'
	}
}

async function read_configured_server(dir: string): Promise<string | null> {
	const config = await read_configured_server_config(dir)
	return config?.server || null
}

async function read_configured_server_config(dir: string): Promise<ServerConfig | null> {
	try {
		return await read_server_config(dir)
	} catch {
		return null
	}
}

function is_remote_server(server: string): boolean {
	try {
		const hostname = new URL(server).hostname
		return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1'
	} catch {
		return false
	}
}

export async function pull_site(options: PullOptions) {
	const spinner = ora('Connecting...').start()

	try {
		// Resolve server (flag > server.yaml in cwd > local detect)
		let server: string
		let used_configured = false
		if (options.server) {
			server = normalize_server_url(options.server)
		} else {
			const configured = await read_configured_server(process.cwd())
			if (configured) {
				// A hand-edited server.yaml may hold a bare host; normalize it so
				// is_remote_server() and the inline-login guard below behave the
				// same as they do for a --server flag.
				server = normalize_server_url(configured)
				used_configured = true
				spinner.text = `Using ${server}`
			} else {
				spinner.text = 'Looking for local server...'
				const detected = await detect_server()
				server = (detected || 'http://localhost:3000').replace(/\/+$/, '')
				spinner.text = `Using ${server}`
			}
		}

		// Auth (optional for local). For a remote server with no cached token,
		// prompt for login inline instead of bailing out — the user almost
		// always wants to authenticate and continue rather than re-run.
		let token = options.token || await get_auth_token(server)
		if (!token && is_remote_server(server)) {
			spinner.stop()
			console.log('')
			console.log(chalk.dim(`  Not logged in to ${server}. Log in to continue.`))
			console.log('')
			token = await authenticate_interactively(server)
			if (!token) {
				process.exit(1)
			}
			spinner.start('Fetching sites...')
		}
		const headers: Record<string, string> = {}
		if (token) {
			headers['Authorization'] = `Bearer ${token}`
		}

		// Decide root dir: explicit --output wins; if cwd already has a configured
		// server.yaml, pull in place; otherwise nest under server hostname.
		// Refuse to auto-create a `localhost/` folder — the user almost certainly
		// didn't mean that. Require --output or --server explicitly in that case.
		if (!options.output && !used_configured && !is_remote_server(server)) {
			spinner.fail(
				`Resolved to ${server} but no output dir was given. ` +
				`Pass --server <url> or --output <dir> to pull a local server.`
			)
			process.exit(1)
		}
		const root_dir = options.output
			? path.resolve(options.output)
			: used_configured
				? process.cwd()
				: path.resolve(server_folder_name(server))

		// Validate the server is reachable BEFORE creating the output dir, so a
		// failed pull doesn't leave an empty folder behind.
		spinner.text = 'Fetching sites...'
		let sites_response: Response
		try {
			sites_response = await fetch(`${server}/api/collections/sites/records?perPage=200`, {
				headers
			})
		} catch (error) {
			spinner.fail(`Could not reach ${server}: ${error instanceof Error ? error.message : error}`)
			process.exit(1)
		}

		if (!sites_response.ok) {
			spinner.fail(`Failed to fetch sites (${sites_response.status})`)
			process.exit(1)
		}

		await fs.mkdir(root_dir, { recursive: true })

		const sites_data = await sites_response.json() as { items: Site[] }
		const sites = sites_data.items || []

		if (sites.length === 0) {
			if (!token) {
				spinner.fail(`Not authenticated. Run \`primo login ${server}\` first.`)
			} else {
				spinner.fail('No sites visible — your token may be expired. Try `primo login` again.')
			}
			process.exit(1)
		}

		// Pull library (best-effort — older servers may not support it)
		const library_pulled = await pull_library_into(server, headers, root_dir, spinner)

		// Pull each site into sites/<slug>/
		const sites_root = path.join(root_dir, 'sites')
		await fs.mkdir(sites_root, { recursive: true })
		const used_slugs = new Set<string>()
		const pulled_sites: Array<{ slug: string; site: Site }> = []
		for (const site of sites) {
			const base_slug = slugify(site.name || site.host || site.id)
			let slug = base_slug
			let n = 2
			while (used_slugs.has(slug)) {
				slug = `${base_slug}-${n++}`
			}
			used_slugs.add(slug)

			const site_dir = path.join(sites_root, slug)
			spinner.start(`Pulling ${chalk.cyan(site.name)}...`)
			await pull_one_site(server, headers, site, site_dir, spinner)
			pulled_sites.push({ slug, site })
		}

		// Fetch site groups so server.yaml has them
		const site_groups = await fetch_site_groups(server, headers)

		// Preserve any existing server.yaml (port, format) and refresh
		// site_groups from the source of truth. Also persist the server URL
		// when it's a remote so subsequent bare `primo pull` runs in this dir
		// don't fall back to localhost detection.
		const existing = await read_configured_server_config(root_dir)
		await write_server_config(root_dir, {
			...existing,
			site_groups: site_groups.length > 0 ? site_groups : existing?.site_groups,
			server: existing?.server ?? (is_remote_server(server) ? server : undefined)
		})

		// Give pulled workspaces the same root AGENTS.md that `primo new`
		// writes — a pulled export is exactly where agents author new site
		// folders and need to know registration is `primo add`, not a side
		// effect of `primo dev`. Never clobber an existing (possibly edited)
		// one.
		const agents_path = path.join(root_dir, 'AGENTS.md')
		try {
			await fs.access(agents_path)
		} catch {
			await fs.writeFile(agents_path, generate_agent_md())
		}

		spinner.succeed(`Server pulled to ${chalk.cyan(root_dir)}`)
		console.log('')
		console.log(chalk.dim('  Sites:'))
		for (const { slug, site } of pulled_sites) {
			console.log(chalk.dim(`    sites/${slug}/  ${chalk.dim(`(${site.name})`)}`))
		}
		if (library_pulled) {
			console.log(chalk.dim('    library/'))
		}
		console.log(chalk.dim(`    server.yaml`))
		console.log('')
		console.log(chalk.green('  Ready for local development!'))
		console.log(chalk.dim(`  cd ${path.relative(process.cwd(), root_dir) || '.'} && primo dev`))

	} catch (error) {
		spinner.fail(`Pull failed: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}
}

async function pull_one_site(
	server: string,
	headers: Record<string, string>,
	site: Site,
	site_dir: string,
	spinner: Ora
) {
	await fs.mkdir(site_dir, { recursive: true })

	spinner.text = `Exporting ${site.name}...`
	const response = await fetch(`${server}/api/primo/export/${site.id}`, { headers })
	if (!response.ok) {
		const error = await response.text()
		throw new Error(`Export failed for ${site.name}: ${error}`)
	}

	const zip_data = await response.arrayBuffer()
	const temp_zip = path.join(site_dir, '.primo-export.zip')
	await fs.writeFile(temp_zip, Buffer.from(zip_data))

	spinner.text = `Extracting ${site.name}...`
	const temp_dir = path.join(site_dir, '.primo', `pull-temp-${Date.now()}`)
	let trashed: string[] = []
	try {
		await fs.mkdir(temp_dir, { recursive: true })
		await extract(temp_zip, { dir: temp_dir })
		await fs.unlink(temp_zip)

		trashed = await reconcile_managed_dirs(site_dir, temp_dir)
		await fs.cp(temp_dir, site_dir, { recursive: true })
	} finally {
		await fs.rm(temp_dir, { recursive: true, force: true })
		// Also drop the archive: on a successful pull it was already unlinked
		// above, but if extract() threw it's still sitting in site_dir.
		await fs.rm(temp_zip, { force: true })
	}

	if (trashed.length > 0) {
		console.log(chalk.dim('  Removed stale files (moved to .primo/trash):'))
		for (const trashed_path of trashed) {
			console.log(chalk.dim(`    ${trashed_path}`))
		}
	}

	await write_site_config(site_dir, {
		name: site.name || 'Imported Site',
		site_id: site.id,
		server,
		group: site.group
	})

	await copy_schemas(site_dir)
	await add_schema_references(site_dir)
}

// Move local files under MANAGED_DIRS that have no counterpart in the fresh
// export into .primo/trash/pull-<ts>/, then remove newly-empty directories
// (best-effort). Returns the trashed paths relative to the site dir.
async function reconcile_managed_dirs(site_dir: string, temp_dir: string): Promise<string[]> {
	const trashed: string[] = []
	const stamp = Date.now()
	for (const dir of MANAGED_DIRS) {
		const local_root = path.join(site_dir, dir)
		const temp_root = path.join(temp_dir, dir)
		for (const relative of await list_files_recursive(local_root)) {
			// Keep the local file only if the export still has a *file* at the
			// same path. If the counterpart is now a directory (a file→dir
			// transition, e.g. pages/foo.yaml became pages/foo/…), the local
			// file is stale and must be trashed — otherwise the later fs.cp
			// can't lay a directory over the surviving file and the pull fails.
			try {
				const counterpart = await fs.stat(path.join(temp_root, relative))
				if (counterpart.isFile()) continue
			} catch {
				// Missing from the export — stale.
			}
			const local_path = path.join(local_root, relative)
			// Scope the trash path by the managed dir. Two managed dirs can hold
			// the same relative name (pages/config.yaml, blocks/config.yaml);
			// without the dir segment they'd collide at trash/pull-<ts>/config.yaml
			// and the second move would clobber the first while both are reported.
			const trash_path = path.join(site_dir, '.primo', 'trash', `pull-${stamp}`, dir, relative)
			await fs.mkdir(path.dirname(trash_path), { recursive: true })
			try {
				await fs.rename(local_path, trash_path)
			} catch {
				// Cross-device move — fall back to copy + delete.
				await fs.copyFile(local_path, trash_path)
				await fs.unlink(local_path)
			}
			trashed.push(`${dir}/${relative}`)
		}
		await remove_empty_dirs(local_root)
	}
	return trashed
}

async function list_files_recursive(root: string, prefix = ''): Promise<string[]> {
	let entries
	try {
		entries = await fs.readdir(root, { withFileTypes: true })
	} catch {
		return []
	}
	const files: string[] = []
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) {
			files.push(...await list_files_recursive(path.join(root, entry.name), relative))
		} else if (entry.isFile()) {
			files.push(relative)
		}
	}
	return files
}

// Remove empty directories bottom-up. rmdir on a non-empty dir fails, which
// we ignore — only newly-emptied dirs go away.
async function remove_empty_dirs(root: string): Promise<void> {
	let entries
	try {
		entries = await fs.readdir(root, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			await remove_empty_dirs(path.join(root, entry.name))
		}
	}
	try {
		await fs.rmdir(root)
	} catch {}
}

async function pull_library_into(
	server: string,
	headers: Record<string, string>,
	root_dir: string,
	spinner: Ora
): Promise<boolean> {
	spinner.start('Pulling library...')
	const response = await fetch(`${server}/api/primo/export-library`, { headers })
	if (response.status === 404) {
		spinner.warn('Library export not supported by this server — skipping')
		return false
	}
	if (!response.ok) {
		spinner.warn(`Library export failed (${response.status}) — skipping`)
		return false
	}

	const zip_data = await response.arrayBuffer()
	const temp_zip = path.join(root_dir, '.primo-library-export.zip')
	await fs.writeFile(temp_zip, Buffer.from(zip_data))
	await extract(temp_zip, { dir: root_dir })
	await fs.unlink(temp_zip)
	return true
}

async function fetch_site_groups(
	server: string,
	headers: Record<string, string>
): Promise<SiteGroupConfig[]> {
	try {
		const response = await fetch(`${server}/api/collections/site_groups/records?perPage=200`, {
			headers
		})
		if (!response.ok) return []
		const data = await response.json() as { items: SiteGroup[] }
		const items = data.items || []
		return items.map((g, i) => ({
			id: g.id,
			name: g.name || g.id,
			index: typeof g.index === 'number' ? g.index : i
		}))
	} catch {
		return []
	}
}

async function copy_schemas(output_dir: string) {
	const current_file = new URL(import.meta.url).pathname
	const dist_dir = path.dirname(path.dirname(current_file))
	const project_root = path.dirname(dist_dir)
	const schemas_src = path.join(project_root, 'schemas')
	const schemas_dest = path.join(output_dir, '.schemas')

	let schema_files: string[]
	try {
		schema_files = await fs.readdir(schemas_src)
	} catch {
		// Schemas not bundled with this CLI install — skip silently
		return
	}

	await fs.mkdir(schemas_dest, { recursive: true })

	for (const file of schema_files) {
		if (file.endsWith('.json')) {
			await fs.copyFile(
				path.join(schemas_src, file),
				path.join(schemas_dest, file)
			)
		}
	}
}

async function add_schema_references(output_dir: string) {
	await stamp_schema_on_dir_configs(
		path.join(output_dir, 'page-types'),
		'config.yaml',
		'../../.schemas/page-type-config.schema.json'
	)
	await stamp_schema_on_dir_configs(
		path.join(output_dir, 'blocks'),
		'config.yaml',
		'../../.schemas/block-config.schema.json'
	)
}

async function stamp_schema_on_dir_configs(parent_dir: string, file_name: string, schema_ref: string) {
	try {
		const entries = await fs.readdir(parent_dir, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const config_path = path.join(parent_dir, entry.name, file_name)
			try {
				const config = load_yaml(await fs.readFile(config_path, 'utf-8'))
				if (!config || typeof config !== 'object' || Array.isArray(config)) continue
				const with_schema = {
					$schema: schema_ref,
					...(config as Record<string, unknown>)
				}
				await fs.writeFile(config_path, dump_yaml(with_schema, { lineWidth: -1, noRefs: true }))
			} catch {}
		}
	} catch {}
}
