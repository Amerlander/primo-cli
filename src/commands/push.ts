import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import ora, { type Ora } from 'ora'
import archiver from 'archiver'
import { prepare_push, append_push_guard, finish_push, response_error, type PushPlan, type PushTarget } from '../utils/push-guard.js'
import { dump as dump_yaml, load as load_yaml } from 'js-yaml'
import { get_auth_token } from '../utils/auth.js'
import { read_site_config, get_site_config_path, type SiteConfig, SITE_CONFIG_FILE } from '../utils/site-config.js'
import { get_server_config_path, read_server_config, resolve_format_options, normalize_server_url, type ServerConfig, type SiteGroupConfig } from '../utils/server-config.js'
import { format_file_contents } from '../utils/format.js'

interface PushOptions {
	server?: string
	site?: string
	only?: string
	dir: string
	token?: string
	preview?: boolean
	dryRun?: boolean
	force?: boolean
	yes?: boolean
}

async function path_exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

// Look up the display name for a group ID by walking up from the site dir
// to find a workspace server.yaml. site.yaml only stores the group ID, so
// without this the server has nothing to label the group with on first push
// and falls back to humanizing the random ID ("8Y17hao5jt2xmd8").
async function resolve_group_name(site_dir: string, group_id: string | undefined): Promise<string | undefined> {
	if (!group_id) return undefined
	// Typical layout: <workspace>/sites/<slug>/site.yaml — server.yaml lives two levels up.
	const candidates = [path.dirname(path.dirname(site_dir)), path.dirname(site_dir), site_dir]
	for (const dir of candidates) {
		if (!(await path_exists(get_server_config_path(dir)))) continue
		try {
			const cfg = await read_server_config(dir)
			const match = cfg.site_groups?.find((g: SiteGroupConfig) => g.id === group_id)
			if (match?.name) return match.name
		} catch {
			// ignore — bad server.yaml shouldn't block the push
		}
	}
	return undefined
}

// Best-effort workspace root for a site dir, used to resolve the workspace
// prettier install when formatting rewritten yaml. Walks up looking for a
// server.yaml; falls back to the site dir if none is found (single-site checkout).
async function root_dir_for(site_dir: string): Promise<string> {
	const candidates = [path.dirname(path.dirname(site_dir)), path.dirname(site_dir), site_dir]
	for (const dir of candidates) {
		if (await path_exists(get_server_config_path(dir))) return dir
	}
	return site_dir
}

// Converge the local site with the upload ids the server minted on push. The
// server creates its own site_uploads record per file (it can't honor a foreign
// CMS's id), renames files to a canonical suffixed name, and returns the
// symbolic->{id,canonical} map. `primo dev` applies this writeback via its
// watcher; `primo push` previously dropped it, so local refs stayed symbolic (or
// worse, kept a stale id from another CMS) and drifted from the server forever.
//
// This mirrors write_upload_writeback in dev.ts but without the chokidar
// bookkeeping (nothing is watching during a push). Best-effort throughout: a
// push has already succeeded by the time we get here, so a writeback hiccup
// should never fail the command.
async function apply_upload_writeback(site_dir: string, workspace_dir: string, created_ids: CreatedIDs | undefined): Promise<void> {
	const manifest = created_ids?.['uploads/.manifest.json']
	const uploads_map = manifest && typeof manifest._uploads === 'object' && manifest._uploads !== null
		? manifest._uploads as Record<string, unknown>
		: null
	if (!uploads_map) return

	// Build symbolic-filename -> record-id map and the rename list. Both
	// symbolic and canonical are treated as untrusted (they come from the
	// server response): reject anything that isn't a plain basename so a
	// crafted `../` can't make a later path.join escape uploads/ (CWE-22).
	const symbolic_to_id = new Map<string, string>()
	const rename_for = new Map<string, string>()
	for (const [symbolic, raw] of Object.entries(uploads_map)) {
		if (!raw || typeof raw !== 'object') continue
		if (!is_safe_basename(symbolic)) continue
		const entry = raw as Partial<UploadWritebackEntry>
		if (typeof entry.id !== 'string' || !entry.id) continue
		symbolic_to_id.set(symbolic, entry.id)
		const canonical = typeof entry.canonical === 'string' ? entry.canonical : ''
		if (canonical && canonical !== symbolic && is_safe_basename(canonical)) {
			rename_for.set(symbolic, canonical)
		}
	}
	if (symbolic_to_id.size === 0) return

	// Rewrite refs FIRST, renames second — and only rename files whose ref
	// rewrite actually succeeded. Renaming before rewriting risks leaving a file
	// at its canonical name while the yaml still points at the old symbolic path
	// (if the rewrite is skipped/unreadable/unwritable), which the next push
	// would resend as a stale ref. So we rewrite yaml, track which symbolic keys
	// were applied, and rename only those — keeping disk and yaml consistent even
	// when some files can't be processed.
	let format_options
	try {
		format_options = resolve_format_options(await read_server_config(workspace_dir))
	} catch {
		format_options = resolve_format_options({} as ServerConfig)
	}
	// Track, per symbolic name, whether it was successfully rewritten in at least
	// one file (`applied`) and whether ANY file that references it could not be
	// persisted (`failed`). The same `upload: uploads/<name>` ref can appear in
	// multiple files, so a name is only safe to rename once EVERY file bearing it
	// is written — otherwise a skipped/failed file keeps the old symbolic ref
	// while the file has already moved to its canonical name.
	const applied = new Set<string>()
	const failed = new Set<string>()
	// Note which symbolic names a raw file mentions, so a file that fails before
	// (or during) parse still marks its refs failed rather than silently passing.
	const referenced_names = (raw: string): string[] =>
		[...symbolic_to_id.keys()].filter(name => raw.includes(`uploads/${name}`))

	for (const subdir of UPLOAD_REF_DIRS) {
		const files = await walk_yaml_files(path.join(site_dir, subdir))
		for (const file_path of files) {
			let content: string
			try {
				content = await fs.readFile(file_path, 'utf-8')
			} catch {
				continue // unreadable file references nothing we can see; skip
			}
			if (!content.includes('uploads/')) continue
			const names_here = referenced_names(content)
			if (names_here.length === 0) continue
			try {
				const parsed = load_yaml(content)
				if (!parsed || typeof parsed !== 'object') {
					names_here.forEach(n => failed.add(n))
					continue
				}
				const { value: rewritten, applied: file_applied } = rewrite_symbolic_upload_refs(parsed, symbolic_to_id)
				if (file_applied.size === 0) continue
				const raw = dump_yaml(rewritten, { lineWidth: -1 })
				const formatted = await format_file_contents(file_path, raw, workspace_dir, format_options)
				await fs.writeFile(file_path, formatted, 'utf-8')
				for (const key of file_applied) applied.add(key)
			} catch {
				// parse/marshal/write failure — this file keeps its symbolic ref,
				// so its name(s) must NOT be renamed even if another file succeeded.
				names_here.forEach(n => failed.add(n))
			}
		}
	}

	// Rename on-disk upload files to their canonical (server-suffixed) names,
	// but only for names that were rewritten somewhere AND had no unpersisted
	// reference anywhere. Missing source = already renamed or user-removed; skip.
	const uploads_dir = path.join(site_dir, 'uploads')
	for (const [symbolic, canonical] of rename_for) {
		if (!applied.has(symbolic) || failed.has(symbolic)) continue
		try {
			await fs.rename(path.join(uploads_dir, symbolic), path.join(uploads_dir, canonical))
		} catch {
			// missing source or permission issue — skip
		}
	}
}

// Guard against path traversal / absolute paths in server-supplied upload
// names. Only accept a plain filename (no separators, no `..`, no leading dot-dot).
function is_safe_basename(name: string): boolean {
	if (!name || name === '.' || name === '..') return false
	if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
	if (path.isAbsolute(name)) return false
	return path.basename(name) === name
}

// Recursively collect .yaml files under a directory (dotfiles/dirs skipped).
async function walk_yaml_files(root: string): Promise<string[]> {
	const out: string[] = []
	const stack: string[] = [root]
	while (stack.length > 0) {
		const dir = stack.pop() as string
		let entries
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) stack.push(full)
			else if (entry.isFile() && entry.name.endsWith('.yaml')) out.push(full)
		}
	}
	return out
}

// Rewrite `upload: "uploads/<file>"` values to the server record id. Mirrors the
// server's rewriteUploadRefs (and dev.ts's copy). Returns the set of symbolic
// filenames it actually remapped so the caller can rename exactly those files
// (and only after the yaml write succeeds). Note this only remaps symbolic
// paths — a bare id that matches no entry is left as-is (see PR notes on the
// separate stale-cross-CMS-id repair still needed for already-broken refs).
function rewrite_symbolic_upload_refs(value: unknown, map: Map<string, string>): { value: unknown; applied: Set<string> } {
	const applied = new Set<string>()
	const walk = (v: unknown): unknown => {
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const obj = v as Record<string, unknown>
			const result: Record<string, unknown> = {}
			for (const [k, val] of Object.entries(obj)) {
				if (k === 'upload' && typeof val === 'string' && val.startsWith('uploads/')) {
					const symbolic = val.substring('uploads/'.length)
					const id = map.get(symbolic)
					if (id) {
						result[k] = id
						applied.add(symbolic)
						continue
					}
				}
				result[k] = walk(val)
			}
			return result
		}
		if (Array.isArray(v)) return v.map(walk)
		return v
	}
	const rewritten = walk(value)
	return { value: rewritten, applied }
}

interface PushDiff {
	blocks: { added: string[]; modified: string[]; deleted: string[] }
	page_types: { added: string[]; modified: string[]; deleted: string[] }
	pages: { added: string[]; modified: string[]; deleted: string[] }
	site: { added: string[]; modified: string[]; deleted: string[] }
}

// The server returns created_ids to let the CLI write back canonical state.
// Upload reconciliation is surfaced under created_ids["uploads/.manifest.json"]
// ._uploads as a symbolic-filename -> { id, canonical } map (id is the server's
// record id; canonical is the PocketBase-suffixed on-disk filename).
type CreatedIDs = Record<string, Record<string, unknown>>

interface UploadWritebackEntry {
	id: string
	canonical: string
}

// Subdirs whose yaml may carry `upload: uploads/...` refs. Mirrors the server's
// import scope (uploads/ itself holds binaries, not refs, so it's excluded).
const UPLOAD_REF_DIRS = ['blocks', 'page-types', 'pages', 'site']

// Returns the labels (site slugs / 'library') that failed to push so callers
// like `primo deploy` can tell a clean run from a partial one. Empty = success.
export async function push_site(options: PushOptions): Promise<string[]> {
	const root_dir = path.resolve(options.dir)
	const has_site_yaml = await path_exists(get_site_config_path(root_dir))
	const has_server_yaml = await path_exists(get_server_config_path(root_dir))

	// Resolve a workspace-level default server URL (server.yaml). Used as the
	// fallback for sites that don't declare their own `server` in site.yaml,
	// and for the library push.
	let workspace_server: string | undefined
	if (has_server_yaml) {
		try {
			const server_config = await read_server_config(root_dir)
			workspace_server = server_config.server
		} catch {
			// fall through — bad server.yaml will surface elsewhere
		}
	}
	const effective_options: PushOptions = workspace_server && !options.server
		? { ...options, server: workspace_server }
		: options

	if (options.dryRun) {
		await print_push_dry_run(root_dir, has_site_yaml, has_server_yaml, effective_options)
		return []
	}

	// Server-folder mode: walk site subfolders + push library
	if (!has_site_yaml && has_server_yaml) {
		const failed = await push_server(root_dir, effective_options)
		if (failed.length > 0) {
			console.log('')
			console.log(chalk.red(`Push incomplete — failed: ${failed.join(', ')}`))
			console.log(chalk.dim('  Fix the errors above and rerun `primo push` (completed pushes are safe to repeat).'))
			console.log('')
			// exitCode (not process.exit) so an in-process caller like `primo
			// deploy` can still finish its own reporting before the process ends.
			process.exitCode = 1
		}
		return failed
	}

	// Single-site mode (cwd is a site folder, or --dir points at one)
	const spinner = ora('Reading local files...').start()
	try {
		await push_single_site(root_dir, effective_options, spinner)
		return []
	} catch (error) {
		spinner.fail(`Push failed: ${error instanceof Error ? error.message : error}`)
		if (is_auth_error(error)) print_auth_hint()
		process.exit(1)
	}
}

function is_auth_error(error: unknown): boolean {
	const msg = error instanceof Error ? error.message : String(error)
	return /Authentication required/i.test(msg) || /\b401\b/.test(msg) || /unauthorized/i.test(msg)
}

function print_auth_hint() {
	console.log('')
	console.log(chalk.dim('  Run `primo login -s <server-url>` to authenticate, then retry.'))
	console.log('')
}

async function print_push_dry_run(root_dir: string, has_site_yaml: boolean, has_server_yaml: boolean, options: PushOptions) {
	console.log('')
	console.log(chalk.bold('Push preview (dry-run)'))
	console.log('')

	if (!has_site_yaml && !has_server_yaml) {
		console.log(chalk.red(`  No ${SITE_CONFIG_FILE} or ${path.basename(get_server_config_path(root_dir))} found in ${root_dir}.`))
		console.log('')
		return
	}

	const sites: { dir: string; config: ReturnType<typeof Object> | null; label: string }[] = []
	let library_present = false
	let inferred_server: string | undefined

	if (has_site_yaml) {
		try {
			const config = await read_site_config(root_dir)
			sites.push({ dir: root_dir, config: config as any, label: config.name || path.basename(root_dir) })
			inferred_server = config.server
		} catch {
			// fall through
		}
	} else if (has_server_yaml) {
		const sites_root = path.join(root_dir, 'sites')
		if (await path_exists(sites_root)) {
			const entries = await fs.readdir(sites_root, { withFileTypes: true })
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith('.')) continue
				const candidate = path.join(sites_root, entry.name)
				if (!await path_exists(get_site_config_path(candidate))) continue
				try {
					const config = await read_site_config(candidate)
					sites.push({ dir: candidate, config: config as any, label: config.name || entry.name })
					inferred_server = inferred_server || config.server
				} catch {
					// skip
				}
			}
		}
		library_present = await path_exists(path.join(root_dir, 'library'))
	}

	const server_raw = options.server || inferred_server
	const server = server_raw ? normalize_server_url(server_raw) : undefined

	console.log(`  Target server: ${chalk.cyan(server || '(not set — pass --server or set in site.yaml)')}`)
	console.log('')
	console.log(chalk.bold('  Will sync:'))
	if (sites.length === 0) {
		console.log(chalk.yellow('    (no sites found)'))
	} else {
		for (const site of sites) {
			console.log(`    ${chalk.green('+')} site: ${site.label}  ${chalk.dim(`(${path.basename(site.dir)})`)}`)
		}
	}
	if (library_present) {
		console.log(`    ${chalk.green('+')} library/`)
	}
	console.log('')

	if (server) {
		const token = options.token || await get_auth_token(server)
		if (token) {
			console.log(chalk.dim(`  Auth: token found for ${server}.`))
		} else {
			console.log(chalk.yellow(`  Auth: not logged in to ${server}. Run \`primo login -s ${server}\`.`))
		}
	}

	if (options.preview) {
		console.log(chalk.dim('  --preview flag set: real push would request a server-side preview only.'))
	}
	console.log('')
	console.log(chalk.dim('  No requests sent. Run without --dry-run to push.'))
	console.log('')
}

async function site_target(site_dir: string, options: PushOptions): Promise<PushTarget> {
	const config = await read_site_config(site_dir)
	const server_raw = options.server || config.server
	if (!server_raw) throw new Error(`Server URL required for ${path.basename(site_dir)}.`)
	const server = normalize_server_url(server_raw)
	const target = options.site || config.site_id
	if (!target) throw new Error(`Site ID required for ${path.basename(site_dir)}.`)
	return { dir: site_dir, server, target, token: options.token || await get_auth_token(server), label: path.basename(site_dir) }
}

// Preflight every target, including the library, before the first upload. Each
// import rechecks its revision; a late conflict stops the remaining uploads.
async function push_server(root_dir: string, options: PushOptions): Promise<string[]> {
	const sites_root = path.join(root_dir, 'sites')
	const site_dirs: string[] = []
	if (await path_exists(sites_root)) {
		for (const entry of await fs.readdir(sites_root, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith('.')) continue
			const candidate = path.join(sites_root, entry.name)
			if (await path_exists(get_site_config_path(candidate))) site_dirs.push(candidate)
		}
	}
	site_dirs.sort()
	const selected = options.only ? site_dirs.filter(dir => path.basename(dir) === options.only) : site_dirs
	if (!selected.length) {
		console.error(options.only ? `No site folder named "${options.only}" under sites/.` : 'No site folders found in this server directory.')
		return [options.only || 'sites']
	}
	let plans: PushPlan[]
	try {
		const targets = await Promise.all(selected.map(dir => site_target(dir, options)))
		if (!options.only && await path_exists(path.join(root_dir, 'library'))) {
			const server = options.server ? normalize_server_url(options.server) : targets[0].server
			targets.push({ dir: root_dir, server, target: 'library', token: options.token || await get_auth_token(server), label: 'library' })
		}
		plans = await prepare_push(targets, options)
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)
		return selected.map(dir => path.basename(dir))
	}
	const completed: string[] = []
	for (let index = 0; index < plans.length; index++) {
		const plan = plans[index]
		const spinner = ora(`Pushing ${plan.label}...`).start()
		try {
			if (plan.target === 'library') {
				if (options.preview) { spinner.info('Library preview is not supported; no library upload sent.'); continue }
				await push_library_dir(root_dir, options, spinner, plan)
			} else {
				await push_single_site(plan.dir, options, spinner, plan)
			}
			completed.push(plan.label)
		} catch (error) {
			spinner.fail(`${plan.label}: ${error instanceof Error ? error.message : error}`)
			if (is_auth_error(error)) print_auth_hint()
			console.log(`Completed: ${completed.join(', ') || 'none'}`)
			console.log(`Failed: ${plan.label}`)
			console.log(`Not attempted: ${plans.slice(index + 1).map(p => p.label).join(', ') || 'none'}`)
			console.log('Earlier successful imports remain saved. The failed request may need verification if its response was lost.')
			return plans.slice(index).map(p => p.label)
		}
	}
	return []
}

async function push_single_site(site_dir: string, options: PushOptions, spinner: Ora, prepared?: PushPlan) {
	spinner.stop()
	const plan = prepared || (await prepare_push([await site_target(site_dir, options)], options))[0]
	spinner.start()
	let config: SiteConfig | null = null
	try {
		config = await read_site_config(site_dir)
	} catch {
		// No config file, must provide options
	}

	const { server, token, target: site_id } = plan

	spinner.text = 'Packaging files...'
	const zip_buffer = await create_zip(site_dir)
	const group_name = await resolve_group_name(site_dir, config?.group)

	// If the user isn't logged in yet, skip the import attempt and try
	// bootstrap directly. Bootstrap doesn't require auth (only allowed when
	// the server has zero sites), so it's the right path for first-time
	// setup against a fresh deployment.
	if (!token) {
		if (plan.exists) throw new Error('Authentication required to update an existing site. Run `primo login` first.')
		if (options.preview) {
			throw new Error('Authentication required for --preview. Run `primo login` first.')
		}
		spinner.text = 'No auth token — attempting bootstrap...'
		const bootstrap_result = await try_bootstrap_site(server, undefined, zip_buffer, config, site_id, group_name, plan)
		if (bootstrap_result.ok) {
			await finish_push(plan, bootstrap_result)
			spinner.succeed(`Bootstrapped ${config?.name || path.basename(site_dir)}`)
			console.log('')
			console.log(chalk.dim('  Site created on server and content uploaded.'))
			console.log(chalk.dim('  Run `primo login` and re-push to update content later.'))
			// Converge local upload refs/filenames with the ids the server minted,
			// same as the other push paths.
			await apply_upload_writeback(site_dir, await root_dir_for(site_dir), bootstrap_result.created_ids)
			return
		}
		throw new Error(bootstrap_result.error)
	}

	const endpoint = options.preview
		? `${server}/api/primo/import/${site_id}/preview`
		: `${server}/api/primo/import/${site_id}`

	spinner.text = options.preview ? 'Previewing changes...' : 'Pushing changes...'

	const form_data = new FormData()
	form_data.append('file', new Blob([zip_buffer]), 'site.zip')
	if (group_name) form_data.append('group_name', group_name)
	append_push_guard(form_data, plan)

	const response = await fetch(endpoint, {
		method: 'POST',
		headers: token ? { 'Authorization': `Bearer ${token}` } : {},
		body: form_data
	})


	if (!response.ok) {
		throw new Error(await response_error(response))
	}

	const result = await response.json() as { preview?: boolean; success?: boolean; diff: PushDiff; created_ids?: CreatedIDs; revision?: string; backup?: string }
	const label = config?.name || path.basename(site_dir)

	if (options.preview) {
		spinner.succeed(`Preview: ${label}`)
		console.log('')
		print_diff(result.diff)
		console.log('')
		console.log(chalk.dim('  Run without --preview to apply these changes'))
	} else {
		await finish_push(plan, result)
		spinner.succeed(`Pushed ${label}`)
		console.log('')
		print_diff(result.diff)
		// The server mints its own record id for each uploaded file and returns
		// the symbolic->id map in created_ids. Converge the local copy so refs
		// point at the server's id and files carry their canonical names — the
		// same writeback `primo dev` does. Without this, local and server drift,
		// and a symbolic ref baked to a *different* CMS's id dangles forever.
		await apply_upload_writeback(site_dir, await root_dir_for(site_dir), result.created_ids)
		// NOTE: push intentionally does NOT republish the served site. It syncs
		// content into the CMS; regenerating the published output stays a
		// separate, deliberate step (the editor's Publish action / the
		// /api/primo/generate endpoint), so pushing content and choosing when it
		// goes live remain decoupled.
	}
}

async function try_bootstrap_site(
	server: string,
	token: string | undefined,
	zip_buffer: Buffer,
	config: SiteConfig | null,
	site_id: string,
	group_name?: string,
	plan?: PushPlan
): Promise<{ ok: true; created_ids?: CreatedIDs; revision?: string } | { ok: false; error: string }> {
	const form = new FormData()
	form.append('site_id', site_id)
	if (plan) append_push_guard(form, plan)
	if (config?.name) form.append('name', config.name)
	if (config?.group) form.append('group', config.group)
	if (group_name) form.append('group_name', group_name)
	// Host is intentionally not sent. A pushed site is created unassigned —
	// the server seeds `host` with a placeholder (the site's own id) so the
	// site is editable in the dashboard but not publicly served until an
	// operator assigns a real domain. The lone exception is bootstrap of the
	// very first site on a fresh instance, where the server falls back to the
	// deploy URL's host so that instance's front door resolves immediately.
	form.append('file', new Blob([zip_buffer]), 'site.zip')

	const headers: Record<string, string> = {}
	if (token) headers['Authorization'] = `Bearer ${token}`

	const response = await fetch(`${server}/api/primo/bootstrap`, {
		method: 'POST',
		headers,
		body: form
	})

	if (response.ok) {
		const body = await response.json().catch(() => ({})) as { created_ids?: CreatedIDs; revision?: string }
		return { ok: true, created_ids: body.created_ids, revision: body.revision }
	}

	if (response.status === 403) {
		return {
			ok: false,
			error:
				`Site '${site_id}' not found on server, and bootstrap is locked ` +
				`(server already has other sites). Create the site in the dashboard first, ` +
				`then update site_id in site.yaml to match.`
		}
	}

	return { ok: false, error: await response.text() }
}

async function push_library_dir(root_dir: string, options: PushOptions, spinner: Ora, plan: PushPlan) {
	const { server, token } = plan

	spinner.text = 'Packaging library...'
	const archive = archiver('zip', { zlib: { level: 9 } })
	const chunks: Buffer[] = []
	const zip_buffer = await new Promise<Buffer>((resolve, reject) => {
		archive.on('data', (chunk) => chunks.push(chunk))
		archive.on('end', () => resolve(Buffer.concat(chunks)))
		archive.on('error', reject)
		archive.directory(path.join(root_dir, 'library'), 'library')
		archive.finalize()
	})

	spinner.text = 'Pushing library...'
	const form_data = new FormData()
	form_data.append('file', new Blob([zip_buffer]), 'library.zip')
	append_push_guard(form_data, plan)

	const response = await fetch(`${server}/api/primo/import-library`, {
		method: 'POST',
		headers: token ? { 'Authorization': `Bearer ${token}` } : {},
		body: form_data
	})

	if (response.status === 404) {
		throw new Error('Library push endpoint disappeared after preflight; no fallback attempted.')
	}
	if (!response.ok) {
		throw new Error(await response_error(response))
	}

	const result = await response.json() as { summary?: { groups: number; blocks: number }; revision?: string; backup?: string }
	await finish_push(plan, result)
	spinner.succeed('Pushed library')
	if (result.summary) {
		console.log(chalk.dim(`    groups/ ${result.summary.groups}, blocks/ ${result.summary.blocks}`))
	}
}

async function create_zip(dir: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const archive = archiver('zip', { zlib: { level: 9 } })
		const chunks: Buffer[] = []

		archive.on('data', chunk => chunks.push(chunk))
		archive.on('end', () => resolve(Buffer.concat(chunks)))
		archive.on('error', reject)

		// Add directories
		const dirs_to_include = ['blocks', 'page-types', 'pages', 'site', 'uploads']
		for (const subdir of dirs_to_include) {
			const full_path = path.join(dir, subdir)
			archive.directory(full_path, subdir)
		}

		// Add site config
		archive.file(path.join(dir, SITE_CONFIG_FILE), { name: SITE_CONFIG_FILE })

		archive.finalize()
	})
}

function print_diff(diff: PushDiff) {
	let has_changes = false

	for (const [section, changes] of Object.entries(diff)) {
		const { added, modified, deleted } = changes as { added: string[]; modified: string[]; deleted: string[] }

		if (added.length === 0 && modified.length === 0 && deleted.length === 0) {
			continue
		}

		has_changes = true
		console.log(chalk.bold(`  ${section}:`))

		for (const item of added) {
			console.log(chalk.green(`    + ${item}`))
		}
		for (const item of modified) {
			console.log(chalk.yellow(`    ~ ${item}`))
		}
		for (const item of deleted) {
			console.log(chalk.red(`    - ${item}`))
		}
	}

	if (!has_changes) {
		console.log(chalk.dim('  No changes detected'))
	}
}
