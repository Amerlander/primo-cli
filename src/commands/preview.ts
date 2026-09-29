import { resolve_dev_server } from '../utils/dev-runtime.js'
import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import { read_site_config } from '../utils/site-config.js'
import { read_server_config, SERVER_CONFIG_FILE } from '../utils/server-config.js'

interface PreviewOptions {
	dir: string
	json?: boolean
}

interface SiteRecord {
	id: string
	name?: string
	host?: string
	[key: string]: unknown
}

interface SyncStatus {
	ok: boolean
	error?: string
	failed_at?: string
}

export interface PreviewResult {
	site_url: string
	pages: number
	symbols: number
}

/**
 * Rebuild a site's published preview. This is the CLI counterpart to the MCP
 * `build_preview` tool, for humans, CI, and agents without an MCP client: it
 * needs only `primo dev` running.
 *
 * The heavy lifting — compiling the site and uploading the preview artifacts —
 * lives in `primo-mcp`'s publish compiler, imported dynamically so a
 * `primo-mcp` without the subpath export degrades with a clear message instead
 * of breaking the command.
 *
 * Throws on any failure; callers format the message.
 */
export async function build_site_preview(site_dir_input: string, api_url_override?: string): Promise<PreviewResult> {
	const site_dir = path.resolve(site_dir_input)

	let config: { site_id?: string; host?: string } | null = null
	try {
		config = (await read_site_config(site_dir)) as { site_id?: string; host?: string } | null
	} catch {
		throw new Error(`No site.yaml found at ${site_dir}/site.yaml — run from a site directory, or pass --dir <site>.`)
	}
	const site_id = config?.site_id
	if (!site_id) {
		throw new Error(`site.yaml at ${site_dir} is missing site_id.`)
	}

	// If the last file→CMS push failed, the server still holds pre-edit state;
	// compiling it would publish a stale preview that looks successful.
	const sync = await read_sync(site_dir)
	if (sync && sync.ok === false) {
		throw new Error(`The most recent file→CMS push failed at ${sync.failed_at ?? 'an unknown time'} and the server still holds pre-edit state. Fix the error and let \`primo dev\` re-import before building a preview. Error: ${sync.error ?? 'unknown'}`)
	}

	let api_url = api_url_override
	if (!api_url) {
		const workspace = await find_workspace(site_dir)
		if (!workspace) {
			throw new Error(`No ${SERVER_CONFIG_FILE} found above ${site_dir}. Run \`primo preview\` from inside a workspace.`)
		}
		api_url = `http://127.0.0.1:${workspace.port}`
		if (!workspace.running) throw new Error(`Could not reach the Primo server at ${api_url}. Start primo dev for this workspace.`)
	}

	const token = await dev_auth(api_url)
	const record = await fetch_site_record(api_url, token, site_id)
	const compile_and_upload = await load_compiler()
	const summary = await compile_and_upload(api_url, token, record)
	await generate(api_url, token, site_id)

	const host = record.host || config?.host
	const site_url = host ? `http://${host}` : `${api_url}/?_site=${encodeURIComponent(site_id)}`
	return { site_url, pages: summary.pageCount, symbols: summary.symbolCount }
}

export async function preview(options: PreviewOptions) {
	const as_json = !!options.json
	try {
		const result = await build_site_preview(options.dir)
		if (as_json) {
			console.log(JSON.stringify({ ok: true, site_url: result.site_url, pages: result.pages, symbols: result.symbols }, null, 2))
			return
		}
		console.log(chalk.green(`✓ Preview rebuilt (${result.pages} page${result.pages === 1 ? '' : 's'})`))
		console.log(`  ${chalk.cyan(result.site_url)}`)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (as_json) {
			console.log(JSON.stringify({ ok: false, error: message }, null, 2))
		} else {
			console.log(chalk.red(message))
		}
		process.exitCode = 1
	}
}

async function read_sync(site_dir: string): Promise<SyncStatus | null> {
	try {
		const raw = await fs.readFile(path.join(site_dir, '.primo', 'sync_status.json'), 'utf-8')
		return JSON.parse(raw) as SyncStatus
	} catch {
		return null
	}
}

async function find_workspace(site_dir: string): Promise<{ dir: string; port: number; running: boolean } | null> {
	let dir = site_dir
	for (;;) {
		try {
			await fs.access(path.join(dir, SERVER_CONFIG_FILE))
			const config = await read_server_config(dir)
			const server = await resolve_dev_server(dir, config.port)
			return { dir, port: server.port, running: server.running }
		} catch {
			// keep walking up
		}
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

async function dev_auth(api_url: string): Promise<string> {
	let response: Response
	try {
		response = await fetch(`${api_url}/api/primo/dev-auth`, {
			method: 'POST',
			signal: AbortSignal.timeout(2000)
		})
	} catch {
		throw new Error(`Could not reach the Primo server at ${api_url}. Is \`primo dev\` running?`)
	}
	if (!response.ok) {
		throw new Error(`The Primo server at ${api_url} did not return a dev token (HTTP ${response.status}). Is \`primo dev\` running?`)
	}
	const body = (await response.json()) as { token?: string }
	if (!body.token) {
		throw new Error('The dev-auth response did not include a token.')
	}
	return body.token
}

async function fetch_site_record(api_url: string, token: string, site_id: string): Promise<SiteRecord> {
	const response = await fetch(`${api_url}/api/collections/sites/records/${encodeURIComponent(site_id)}`, {
		headers: { Authorization: token }
	})
	if (response.status === 404) {
		throw new Error(`Site ${site_id} was not found on the server at ${api_url}. Is \`primo dev\` running for this workspace?`)
	}
	if (!response.ok) {
		const body = await response.text().catch(() => '')
		throw new Error(`Could not read the site record (HTTP ${response.status}): ${body || 'no body'}`)
	}
	return (await response.json()) as SiteRecord
}

type CompileAndUpload = (
	api_url: string,
	token: string,
	record: SiteRecord
) => Promise<{ pageCount: number; symbolCount: number }>

async function load_compiler(): Promise<CompileAndUpload> {
	// Non-literal specifier: the subpath only exists in primo-mcp >= 0.1.8, so a
	// static specifier would fail to type-resolve against older installs.
	const compiler_specifier = 'primo-mcp/compiler'
	try {
		const compiler = (await import(compiler_specifier)) as { compileAndUploadPublishArtifacts: CompileAndUpload }
		return compiler.compileAndUploadPublishArtifacts
	} catch {
		throw new Error('This build of primo-mcp does not expose its compiler subpath (needs primo-mcp >= 0.1.8). Upgrade with `npm i -g primo-mcp@latest` (or `npx primo-mcp@latest`).')
	}
}

async function generate(api_url: string, token: string, site_id: string): Promise<void> {
	const response = await fetch(`${api_url}/api/primo/generate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: token },
		body: JSON.stringify({ site_id })
	})
	if (!response.ok) {
		const body = await response.text().catch(() => '')
		throw new Error(`Preview generation failed (HTTP ${response.status}): ${body || 'no body'}`)
	}
}
