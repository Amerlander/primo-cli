import fs from 'fs/promises'
import path from 'path'
import { createHash, randomInt } from 'crypto'
import chalk from 'chalk'
import ora from 'ora'
import inquirer from 'inquirer'
import http, { type RequestListener } from 'http'
import { requested_dev_port, select_dev_port, is_port_in_use } from '../utils/dev-port.js'
import { claim_dev_runtime, read_dev_runtime, runtime_has_live_process, record_cms_process } from '../utils/dev-runtime.js'
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import archiver from 'archiver'
import extract from 'extract-zip'
import { dump as dump_yaml, load as load_yaml } from 'js-yaml'
import chokidar, { type FSWatcher } from 'chokidar'
import { ensure_binary, ensure_data_dir } from '../utils/binary.js'
import { read_site_config, write_site_config, type SiteConfig, SITE_CONFIG_FILE } from '../utils/site-config.js'
import { read_server_config, write_server_config, type ServerConfig, type SiteGroupConfig, format_group_name, group_id_notice, SERVER_CONFIG_FILE, resolve_format_options } from '../utils/server-config.js'
import { format_file_contents, should_format, type FormatOptions } from '../utils/format.js'
import { normalize_site } from './validate.js'

interface DevOptions {
	dir: string
	port?: string
	force?: boolean
	author?: string
}

interface SiteInfo {
	dir: string
	config: SiteConfig
}

type SyncMode = 'both' | 'files' | 'cms'

type SyncPolicy = {
	mode: SyncMode
}

function local_dev_host(name: string, port: number | string): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site'
	return `${slug}.localhost:${port}`
}

let cms_process: ChildProcess | null = null
let watchers: FSWatcher[] = []
let reimport_timeout: NodeJS.Timeout | null = null
let library_reimport_timeout: NodeJS.Timeout | null = null
let sync_interval: NodeJS.Timeout | null = null
let is_syncing = false
let is_importing = false
let is_cleaning_up = false
let last_import_time = 0  // Timestamp of last import completion
let last_local_change_time = 0  // Timestamp of most recent local watcher event
const importing_site_keys = new Set<string>()
const pending_local_site_keys = new Set<string>()
// Sites whose last import returned null (duplicate _ids across files — nothing
// was pushed). They stay quarantined until a later import succeeds: no CMS→file
// polling into them (a quarantined site is out of sync with the CMS, so copying
// remote-only paths in could clobber the local files the user must edit to fix
// the conflict). Cleared on the next successful import.
const blocked_site_keys = new Set<string>()
let is_importing_library = false
let has_pending_library_local_changes = false
let site_sync_baselines = new Map<string, ContentSnapshot>()
// Tracks the last set of conflict paths logged per site so we don't reprint
// the same conflict block every pull cycle when primo's serialization
// keeps producing the same divergence (e.g. data-key mangling, key reorder).
const last_logged_conflicts = new Map<string, string>()

// Track files written by sync to prevent watcher from re-pushing them.
// Keyed by absolute path; value is the SHA-256 of the content we wrote.
// We compare against the file's *current* hash in the watcher, so a user
// edit that happens within the polling cycle is detected by content
// divergence rather than mtime±tolerance (which used to drop edits made
// within 3 seconds of a sync-write).
const synced_files = new Map<string, string>()
const synced_deleted_paths = new Map<string, number>()
const warned_empty_schema_writebacks = new Set<string>()
// Sites whose CMS export currently looks too thin to mirror. Keyed by site so
// the 1s poll prints the refusal once instead of every cycle, and cleared as
// soon as the export recovers so a later occurrence is reported again.
const warned_thin_exports = new Set<string>()

// Snapshot of library folder paths known to be in the DB after the last
// successful push, mapped to the underlying DB record ID (group id or
// symbol/block id from config.yaml). Paths are posix-style and relative to
// the library root, e.g. "marketing" (group) or "marketing/hero-split"
// (block). A diff against the current filesystem between pushes is what
// produces the `deletes` manifest: if a path was in the last snapshot but
// isn't on disk now, its ID is sent to the server as an explicit delete.
type LibrarySnapshot = Map<string, { kind: 'group' | 'block'; id: string | null }>
let library_snapshot: LibrarySnapshot = new Map()

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const SITES_DIR = 'sites'
const LIBRARY_DIR = 'library'
const MCP_CONFIG_FILE = '.mcp.json'
const SITE_SYNC_DIRS = ['blocks', 'page-types', 'pages', 'site']
// Every site needs this file to boot — `primo dev` refuses to start without
// it (see validate.ts). Used as the liveness check on a CMS export before we
// let it prune local files.
const HOMEPAGE_FILE = 'pages/index.yaml'

type IDCategory = 'pages' | 'page_sections' | 'blocks' | 'page_types' | 'site_fields' | 'block_fields' | 'page_type_fields'

type DuplicateOccurrence = {
	owner: string
	file: string
}

type LocalDevPreparation = {
	excluded_paths: Set<string>
	warnings: string[]
}

type BlockContentReference = {
	page: string
	section_index: number
	keys: string[]
}

type SyncDirectoryOptions = {
	workspace_dir?: string
	format_options?: FormatOptions
	block_content_refs?: Map<string, BlockContentReference[]>
	site_name?: string
	// Relative paths the caller has already determined are conflicted.
	// sync_directory leaves these files untouched on disk and skips both
	// overwrite and delete for them — implements the "files win on conflict"
	// default policy.
	skip_paths?: Set<string>
}

type SnapshotOptions = {
	workspace_dir?: string
	format_options?: FormatOptions
	dest_root?: string
}

type ContentSnapshot = Map<string, string>

export type ImportTimings = {
	zip_ms: number
	request_ms: number
	mode: 'bootstrap' | 'import' | 'bootstrap+import'
	// Whether an import actually landed. The bootstrap+import fallback path
	// returns timings even when both the bootstrap and the fallback import
	// fail (it only logs), so a returned ImportTimings does not imply success.
	// Callers persist ok:false to sync_status.json in that case rather than a
	// phantom ok:true.
	ok: boolean
	warning_count: number
	dropped_field_count: number
	// Full per-field warning records from the import response. Carried up so
	// write_sync_status can persist the actual dropped-field details (file,
	// path, block, field, message) to sync_status.json for agents to read,
	// not just the aggregate count. Empty on a clean import.
	warning_details: ImportWarning[]
}

const LOCAL_PUSH_DEBOUNCE_MS = 150
const LOCAL_ZIP_COMPRESSION_LEVEL = 0

function hash_content(content: string | Buffer): string {
	return createHash('sha256').update(content).digest('hex')
}

// Returns true iff the file at `full_path` still has the exact content
// we last synced to it. Used by watcher event handlers to ignore their
// own writes without the old mtime-tolerance race that swallowed user
// edits made within seconds of a sync-write.
async function event_matches_synced_write(full_path: string): Promise<boolean> {
	const expected_hash = synced_files.get(full_path)
	if (!expected_hash) return false
	try {
		const current = await fs.readFile(full_path)
		return hash_content(current) === expected_hash
	} catch {
		return false
	}
}
// When the user writes a file locally, suppress CMS->local pulls for this
// long to prevent a pull that was in-flight before the watcher fired from
// stomping the just-written content on arrival.
const LOCAL_CHANGE_PULL_COOLDOWN_MS = 3000
// Prior file content is copied to .primo/trash/ before any CMS->file
// overwrite so the user can recover work if the sync picked the wrong side.
// Entries older than this are pruned on dev server startup.
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

async function trash_existing_file(
	prior_content: string,
	workspace_dir: string,
	site_name: string,
	file_relative: string
): Promise<void> {
	const trash_dir = path.join(workspace_dir, '.primo', 'trash')
	await fs.mkdir(trash_dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const safe_path = file_relative.replace(/[/\\]/g, '__')
	const trash_path = path.join(trash_dir, `${stamp}_${site_name}_${safe_path}`)
	await fs.writeFile(trash_path, prior_content)
}

// Remove a path the CMS export dropped, trashing each file first so the delete
// stays recoverable the same way an overwrite does.
//
// Descendants listed in skip_paths are kept: the "files win on conflict"
// policy is per-file, so removing a directory wholesale would delete a
// conflicted file the caller had already decided to preserve. A directory is
// only removed once every child under it is gone.
//
// A file or directory whose backup can't be taken — unreadable, trash write
// failed, or no trash location configured — is kept, not deleted: unlike an
// overwrite there is no incoming copy anywhere else, so deleting it anyway
// would be unrecoverable.
//
// Returns true when nothing survived, so the caller can report a clean delete.
async function prune_dropped_path(
	target_path: string,
	file_relative: string,
	options: SyncDirectoryOptions
): Promise<boolean> {
	if (options.skip_paths?.has(file_relative)) return false

	let stat
	try {
		// lstat, not stat: a symlink has to be a leaf here. The tree delete
		// this replaced (fs.rm recursive) never followed links, so walking
		// into one would be a new way to delete files outside the site.
		stat = await fs.lstat(target_path)
	} catch (error) {
		// Only a vanished path counts as gone; an lstat that failed for
		// another reason inspected nothing, so nothing may be removed.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
		console.log(chalk.dim(`  kept ${file_relative}: not deleted (could not inspect)`))
		return false
	}

	if (stat.isSymbolicLink()) {
		// A link is a leaf: unlink only the link itself. remove_tracked_path
		// would also walk the target tree (mark_deleted_tree's readdir follows
		// the link), bookkeeping paths outside the site for no benefit.
		try {
			await fs.unlink(target_path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
			console.log(chalk.dim(`  kept ${file_relative}: not deleted (could not remove link)`))
			return false
		}
		mark_deleted_path(target_path)
		return true
	}

	if (!stat.isDirectory()) {
		if (!options.workspace_dir || !options.site_name) {
			console.log(chalk.dim(`  kept ${file_relative}: not deleted without a trash backup (no trash location)`))
			return false
		}
		const content = await fs.readFile(target_path, 'utf-8').catch(() => null)
		if (content === null) {
			console.log(chalk.dim(`  kept ${file_relative}: not deleted without a trash backup (unreadable)`))
			return false
		}
		try {
			await trash_existing_file(content, options.workspace_dir, options.site_name, file_relative)
		} catch {
			console.log(chalk.dim(`  kept ${file_relative}: not deleted without a trash backup (trash write failed)`))
			return false
		}
		await remove_tracked_path(target_path)
		return true
	}

	let entries
	try {
		entries = await fs.readdir(target_path, { withFileTypes: true })
	} catch {
		// A tree that can't be enumerated can't be backed up either; removing
		// it anyway would delete children no trash copy was made of.
		console.log(chalk.dim(`  kept ${file_relative}: not deleted without a trash backup (unreadable)`))
		return false
	}
	let emptied = true
	for (const entry of entries) {
		const child_path = path.join(target_path, entry.name)
		const child_relative = `${file_relative}/${entry.name}`
		if (!await prune_dropped_path(child_path, child_relative, options)) {
			emptied = false
		}
	}

	if (emptied) {
		// rmdir, not a recursive remove: everything enumerated above is gone,
		// but a child may have been re-created since the readdir. A plain
		// rmdir refuses (ENOTEMPTY) rather than delete content that arrived
		// after enumeration and so was never trashed.
		try {
			await fs.rmdir(target_path)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return true
			return false
		}
		mark_deleted_path(target_path)
		return true
	}
	return emptied
}

function describe_pruned_path(file_relative: string, removed_all: boolean): string {
	return removed_all
		? `${file_relative} (deleted, prior in .primo/trash/)`
		: `${file_relative} (partially deleted; conflicted local files kept)`
}

// Compare line counts between prior and incoming content to flag suspicious
// shrinkage. Returns the negative delta (e.g. -12) when the file lost lines
// or was emptied; null when it grew, stayed the same, or didn't exist before.
function compute_shrink_delta(prior: string, next: string): number | null {
	if (!prior) return null
	const prior_lines = prior.split('\n').length
	const next_lines = next.split('\n').length
	const delta = next_lines - prior_lines
	return delta < 0 ? delta : null
}

// Where the running dev server can be reached, stamped into every
// sync_status.json write so an agent reading the file also learns where the
// server is — and never needs to spawn its own to find out.
type DevLocation = {
	port?: number
	url?: string
}

// The most recent import/push outcome, as persisted to sync_status.json.
// `warning_details` carries the full per-field records (file, path, block,
// field, message) — not just the count — so an agent can read exactly what
// was dropped without re-running dev and scraping stdout. The top-level
// `ok`/`warnings`/`warned_at`/`error`/`failed_at` fields are preserved for
// the existing MCP build_preview reader.
type SyncStatusOutcome =
	| { ok: true }
	| { ok: true; warnings: number; warned_at: string; warning_details?: ImportWarning[] }
	| { ok: false; error: string; failed_at: string }

// Write the most recent push outcome to a file the MCP build_preview and
// get_dev_status tools read, so the agent learns when its file changes failed
// to land in the CMS and exactly which fields were dropped. Without this,
// build_preview compiles whatever stale DB state existed before the failed
// push and reports ok:true, leaving the agent to chase phantom rendering bugs
// instead of fixing the source error.
async function write_sync_status(
	site_dir: string,
	status: SyncStatusOutcome,
	location: DevLocation = {}
): Promise<void> {
	const status_dir = path.join(site_dir, '.primo')
	try {
		await fs.mkdir(status_dir, { recursive: true })
		// last_import_at stamps every write so a reader can tell a fresh status
		// from a stale one; port/url tell the agent where the server is.
		const payload = {
			...status,
			...(location.port !== undefined ? { port: location.port } : {}),
			...(location.url !== undefined ? { url: location.url } : {}),
			last_import_at: new Date().toISOString()
		}
		// Write atomically: a plain fs.writeFile truncates-then-writes, so the
		// MCP get_dev_status reader can catch a half-written file and briefly
		// report "not running" mid-write. Write to a temp file in the same dir
		// (same filesystem → rename is atomic on POSIX) and rename over the
		// target, so readers always see a complete old or new file.
		const target = path.join(status_dir, 'sync_status.json')
		const tmp = path.join(status_dir, `sync_status.${process.pid}.${randomInt(1e9)}.tmp`)
		try {
			await fs.writeFile(tmp, JSON.stringify(payload, null, 2))
			await fs.rename(tmp, target)
		} catch (err) {
			await fs.unlink(tmp).catch(() => {})
			throw err
		}
	} catch {
		// Status reporting must not break the push.
	}
}

// Persist a successful import's outcome to sync_status.json — with the full
// per-field warning details when content was dropped, so an agent can read
// exactly what was lost without re-running dev. Shared by the boot loop and
// the file watcher so both readers of the file see the same shape.
async function write_import_sync_status(
	site_dir: string,
	import_timings: ImportTimings,
	location: DevLocation
): Promise<void> {
	// The bootstrap+import fallback can return timings even when nothing
	// imported (both attempts failed and were only logged). Never record a
	// phantom success for that — write ok:false so the agent doesn't build a
	// preview from unchanged CMS state.
	if (!import_timings.ok) {
		await write_sync_status(site_dir, {
			ok: false,
			error: 'Import failed — see the primo dev logs for details.',
			failed_at: new Date().toISOString()
		}, location)
		return
	}
	if (import_timings.warning_count > 0) {
		await write_sync_status(site_dir, {
			ok: true,
			warnings: import_timings.warning_count,
			warned_at: new Date().toISOString(),
			warning_details: import_timings.warning_details
		}, location)
	} else {
		await write_sync_status(site_dir, { ok: true }, location)
	}
}

async function prune_old_trash(workspace_dir: string): Promise<void> {
	const trash_dir = path.join(workspace_dir, '.primo', 'trash')
	try {
		const entries = await fs.readdir(trash_dir)
		const cutoff = Date.now() - TRASH_RETENTION_MS
		await Promise.all(entries.map(async name => {
			const full = path.join(trash_dir, name)
			const stat = await fs.stat(full).catch(() => null)
			if (stat && stat.mtimeMs < cutoff) {
				await fs.unlink(full).catch(() => {})
			}
		}))
	} catch {
		// trash dir doesn't exist yet — nothing to prune
	}
}

function get_site_sync_key(site_dir: string, config: SiteConfig): string {
	return config.site_id || site_dir
}

function resolve_sync_policy(options: DevOptions): SyncPolicy {
	// Default mirrors the CLI's --author default: files-authoritative.
	// This branch matters for callers that invoke dev_server programmatically
	// (e.g. `primo new` after scaffolding) and bypass commander's default.
	const raw = options.author ?? 'files'
	if (raw !== 'files' && raw !== 'cms' && raw !== 'both') {
		throw new Error(`Invalid --author value "${raw}". Use "files", "cms", or "both".`)
	}
	return { mode: raw }
}

function is_file_to_cms_active(sync_policy: SyncPolicy): boolean {
	return sync_policy.mode !== 'cms'
}

function is_cms_to_file_active(sync_policy: SyncPolicy): boolean {
	return sync_policy.mode !== 'files'
}

function describe_sync_state(sync_policy: SyncPolicy, sites: SiteInfo[]): string {
	const file_state = is_file_to_cms_active(sync_policy)
		? 'file→CMS active'
		: 'file→CMS paused (--author cms)'

	let cms_state: string
	if (!is_cms_to_file_active(sync_policy)) {
		cms_state = 'CMS→file paused (--author files)'
	} else {
		const pending_sites = sites
			.filter(site => pending_local_site_keys.has(get_site_sync_key(site.dir, site.config)))
			.map(site => site.config.name)

		if (pending_sites.length > 0) {
			const shown = pending_sites.slice(0, 3).join(', ')
			const suffix = pending_sites.length > 3 ? `, +${pending_sites.length - 3} more` : ''
			cms_state = `CMS→file paused (pending local imports/warnings: ${shown}${suffix})`
		} else if (sync_policy.mode === 'both') {
			cms_state = 'CMS→file active (auto-pauses during local imports)'
		} else {
			cms_state = 'CMS→file active'
		}
	}

	return `${file_state}, ${cms_state}`
}

function print_sync_status(sync_policy: SyncPolicy, sites: SiteInfo[]): void {
	console.log(chalk.dim(`  watching: ${describe_sync_state(sync_policy, sites)}`))
}

function update_site_sync_state_after_import(site: SiteInfo, timings: ImportTimings, sync_policy: SyncPolicy): boolean {
	const site_key = get_site_sync_key(site.dir, site.config)
	if (timings.warning_count > 0) {
		pending_local_site_keys.add(site_key)
		if (is_cms_to_file_active(sync_policy)) {
			console.log(chalk.yellow(`  ${site.config.name}: CMS-to-file sync paused until import warnings are resolved.`))
		}
		return false
	}

	const was_pending = pending_local_site_keys.delete(site_key)
	if (was_pending && is_cms_to_file_active(sync_policy)) {
		console.log(chalk.dim(`  ${site.config.name}: CMS-to-file sync resumed.`))
	}

	return true
}

// The baseline must reflect what the CMS actually has after a write, not what
// we wrote to disk. The import endpoint mutates records as a side effect
// (bumps `updated`, delete+inserts page_sections and *_entries with new IDs,
// normalizes field shapes), so a baseline snapshotted from local files
// disagrees with the CMS export on the very next pull and find_conflict_paths
// reports a phantom conflict — losing the user's edits to .primo/trash/.
// Fetching the post-import export and snapshotting that keeps the baseline
// aligned with the remote. Falls back to the local snapshot if the fetch
// fails so we don't lose conflict detection on transient network errors.
async function update_site_sync_baseline(
	site: SiteInfo,
	api_url?: string,
	server_config?: ServerConfig,
	workspace_dir?: string
): Promise<void> {
	const site_key = get_site_sync_key(site.dir, site.config)

	if (api_url && server_config && workspace_dir) {
		try {
			const cms_snapshot = await fetch_cms_site_snapshot(
				site.dir, api_url, site.config, server_config, workspace_dir, 'baseline-temp'
			)
			if (cms_snapshot) {
				site_sync_baselines.set(site_key, cms_snapshot)
				return
			}
		} catch {
			// Fall through to local snapshot.
		}
	}

	site_sync_baselines.set(site_key, await collect_site_snapshot(site.dir))
}

function get_site_sync_baseline(site: SiteInfo): ContentSnapshot | undefined {
	return site_sync_baselines.get(get_site_sync_key(site.dir, site.config))
}

function hash_snapshot_content(contents: string): string {
	return createHash('sha256').update(contents.trim()).digest('hex')
}

function snapshot_value(snapshot: ContentSnapshot, file_path: string): string | null {
	return snapshot.has(file_path) ? snapshot.get(file_path)! : null
}

// Reads a file but treats ENOENT as a soft miss — primo' export step can
// reshape the on-disk layout (e.g. promoting pages/foo.yaml to
// pages/foo/index.yaml when a child route is added) between when a directory
// listing is captured and when each file is read. The vanished file isn't an
// error; it's just out of scope for this snapshot.
async function read_file_or_vanish(full_path: string, label: string): Promise<string | null> {
	try {
		return await fs.readFile(full_path, 'utf-8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			console.log(chalk.dim(`  skipped (vanished): ${label}`))
			return null
		}
		throw error
	}
}

// A path is "in conflict" when local has content that differs from CMS AND
// the local content represents a real user change — not just CMS-side
// serialization noise (primo re-emits YAML with normalized key order,
// ISO-coerced dates, etc., so the CMS export legitimately differs from a
// freshly-scaffolded file forever, and we don't want to scream about that
// every pull cycle).
//
// "Real user change" means one of:
//   - No baseline entry exists for this path (brand-new local file the
//     CMS hasn't seen yet — protects the post-scaffold race)
//   - Local content differs from baseline (user has edited the file since
//     the last successful sync)
//
// If the baseline matches local but CMS differs, that's pure CMS-side
// drift — pure pull, no conflict, the CMS value is allowed to overwrite.
function find_conflict_paths(base: ContentSnapshot | undefined, local: ContentSnapshot, cms: ContentSnapshot): string[] {
	const conflicts: string[] = []
	for (const [file_path, local_value] of local) {
		if (local_value === undefined || local_value === null) continue
		const cms_value = snapshot_value(cms, file_path)
		const base_value = base ? snapshot_value(base, file_path) : null

		// Same content on both sides → not a conflict.
		if (cms_value !== null && cms_value === local_value) continue

		// CMS-side delete: still a conflict if local has content the user
		// authored (covers the case of a brand-new local file the CMS
		// hasn't been told about yet).
		const local_is_new = base_value === null
		const local_is_edited = base_value !== null && local_value !== base_value
		if (!local_is_new && !local_is_edited) continue

		conflicts.push(file_path)
	}
	return conflicts.sort()
}

function log_sync_conflict(site_name: string, winner: 'files' | 'CMS' | 'unresolved', reason: string, paths: string[]): void {
	if (paths.length === 0) return

	const winner_text = winner === 'unresolved'
		? chalk.red('NO SIDE WON — files diverged')
		: winner === 'files'
			? chalk.green('FILES WON')
			: chalk.blue('CMS WON')

	// Blank lines + bold header so the conflict is impossible to miss in
	// the surrounding push/pull spam. Beta users need to see this clearly.
	console.log('')
	console.log(chalk.bold.yellow(`  ⚠ SYNC CONFLICT  ${site_name}  →  ${winner_text}`))
	console.log(chalk.dim(`     reason: ${reason}`))
	for (const p of paths.slice(0, 10)) {
		console.log(chalk.yellow(`     • ${p}`))
	}
	if (paths.length > 10) {
		console.log(chalk.dim(`     • +${paths.length - 10} more`))
	}
	if (winner === 'CMS') {
		console.log(chalk.dim(`     prior file content saved to .primo/trash/`))
	}
	console.log('')
}

async function collect_site_snapshot(root_dir: string, options: SnapshotOptions = {}): Promise<ContentSnapshot> {
	const snapshot: ContentSnapshot = new Map()
	for (const dir of SITE_SYNC_DIRS) {
		await collect_directory_snapshot(path.join(root_dir, dir), dir, snapshot, options)
	}
	return snapshot
}

async function collect_directory_snapshot(
	current_dir: string,
	relative_dir: string,
	snapshot: ContentSnapshot,
	options: SnapshotOptions
): Promise<void> {
	let entries
	try {
		entries = await fs.readdir(current_dir, { withFileTypes: true })
	} catch {
		return
	}

	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue

		const full_path = path.join(current_dir, entry.name)
		const file_relative = relative_dir ? `${relative_dir}/${entry.name}` : entry.name

		if (entry.isDirectory()) {
			await collect_directory_snapshot(full_path, file_relative, snapshot, options)
			continue
		}
		if (!entry.isFile()) continue

		const initial = await read_file_or_vanish(full_path, file_relative)
		if (initial === null) continue
		let contents = initial
		const dest_path = options.dest_root ? path.join(options.dest_root, file_relative) : full_path
		if (options.format_options && options.workspace_dir && should_format(dest_path)) {
			contents = await format_file_contents(dest_path, contents, options.workspace_dir, options.format_options)
		}
		snapshot.set(file_relative, hash_snapshot_content(contents))
	}
}

async function fetch_cms_site_snapshot(
	site_dir: string,
	api_url: string,
	config: SiteConfig,
	server_config: ServerConfig,
	workspace_dir: string,
	temp_name: string
): Promise<ContentSnapshot | null> {
	const response = await fetch_with_timeout(`${api_url}/api/primo/export/${config.site_id}`, {}, 15000)
	if (!response.ok) return null

	const temp_dir = path.join(site_dir, '.primo', temp_name)
	const temp_zip = path.join(temp_dir, 'export.zip')

	await fs.rm(temp_dir, { recursive: true, force: true })
	await fs.mkdir(temp_dir, { recursive: true })

	try {
		const zip_data = await response.arrayBuffer()
		await fs.writeFile(temp_zip, Buffer.from(zip_data))
		await extract(temp_zip, { dir: temp_dir })
		await fs.unlink(temp_zip)

		return await collect_site_snapshot(temp_dir, {
			workspace_dir,
			format_options: resolve_format_options(server_config),
			dest_root: site_dir
		})
	} finally {
		await fs.rm(temp_dir, { recursive: true, force: true })
	}
}

async function detect_site_file_push_conflicts(
	site: SiteInfo,
	api_url: string,
	server_config: ServerConfig,
	workspace_dir: string
): Promise<string[]> {
	const baseline = get_site_sync_baseline(site)
	if (!baseline) return []

	const [local_snapshot, cms_snapshot] = await Promise.all([
		collect_site_snapshot(site.dir),
		fetch_cms_site_snapshot(site.dir, api_url, site.config, server_config, workspace_dir, 'conflict-temp')
	])
	if (!cms_snapshot) return []

	return find_conflict_paths(baseline, local_snapshot, cms_snapshot)
}

async function with_site_import_lock<T>(site_dir: string, config: SiteConfig, fn: () => Promise<T>): Promise<T> {
	const site_key = get_site_sync_key(site_dir, config)
	importing_site_keys.add(site_key)
	try {
		return await fn()
	} finally {
		importing_site_keys.delete(site_key)
	}
}

// Kill processes on a specific port
async function kill_port(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const lsof = spawn('lsof', ['-ti', `:${port}`])
		let pids = ''
		lsof.stdout.on('data', (data) => { pids += data.toString() })
		lsof.on('close', () => {
			const pid_list = pids.trim().split('\n').filter(Boolean)
			if (pid_list.length === 0) {
				resolve(false)
				return
			}
			// Don't kill ourselves or our ancestors — lsof returns every PID
			// holding the port, which on macOS includes parent processes that
			// inherited the fd. SIGKILL'ing them takes this CLI down too.
			const self_ancestry = get_self_ancestry()
			let killed_any = false
			for (const pid of pid_list) {
				const pid_num = parseInt(pid, 10)
				if (self_ancestry.has(pid_num)) continue
				try {
					process.kill(pid_num, 'SIGKILL')
					killed_any = true
				} catch {
					// Process may have already exited
				}
			}
			resolve(killed_any)
		})
	})
}

function get_self_ancestry(): Set<number> {
	const ancestry = new Set<number>()
	let pid: number | undefined = process.pid
	while (pid && pid > 1) {
		ancestry.add(pid)
		pid = get_parent_pid(pid)
		if (pid && ancestry.has(pid)) break
	}
	return ancestry
}

function get_parent_pid(pid: number): number | undefined {
	try {
		const result = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore']
		})
		const parsed = parseInt(String(result).trim(), 10)
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
	} catch {
		return undefined
	}
}

// Fetch with timeout helper
async function fetch_with_timeout(url: string, options: RequestInit = {}, timeout_ms = 10000): Promise<Response> {
	const controller = new AbortController()
	const timeout_id = setTimeout(() => controller.abort(), timeout_ms)

	try {
		const response = await fetch(url, { ...options, signal: controller.signal })
		return response
	} finally {
		clearTimeout(timeout_id)
	}
}

// Kill process with escalation to SIGKILL
export async function kill_process(proc: ChildProcess): Promise<void> {
	if (!proc || proc.killed) return

	proc.kill('SIGTERM')

	// Wait up to 3 seconds for graceful shutdown
	const start = Date.now()
	while (Date.now() - start < 3000) {
		if (proc.killed || proc.exitCode !== null) return
		await new Promise(resolve => setTimeout(resolve, 100))
	}

	// Force kill if still running
	if (!proc.killed && proc.exitCode === null) {
		proc.kill('SIGKILL')
	}
}

export async function dev_server(options: DevOptions) {
	const spinner = ora('Starting Primo...').start()

	try {
		const sync_policy = resolve_sync_policy(options)
		site_sync_baselines = new Map()
		const base_dir = path.resolve(options.dir)
		await prune_old_trash(base_dir)
		const mcp_registration_path = await register_primo_mcp_server(base_dir)

		// Check for server config (multi-site mode) or site config (single-site mode)
		const server_config_path = path.join(base_dir, SERVER_CONFIG_FILE)

		let server_config: ServerConfig = {}
		let sites: SiteInfo[] = []
		let is_server_mode = false

		try {
			server_config = await read_server_config(base_dir)
			is_server_mode = true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}

		const requested = requested_dev_port(options.port, server_config.port)
		const previous_runtime = await read_dev_runtime(base_dir)
		if (previous_runtime && runtime_has_live_process(previous_runtime) && !(options.force && requested.port === previous_runtime.port)) {
			throw new Error(`This workspace already has a Primo server running or starting on port ${previous_runtime.port}. Stop it before starting another.`)
		}
		if (options.force) {
			for (const candidate of [requested.port, requested.port + 1]) {
				if (await is_port_in_use(candidate)) await kill_port(candidate)
			}
			await new Promise(resolve => setTimeout(resolve, 500))
		}
		const port = await select_dev_port({
			...requested,
			// Force means use the requested pair, not silently fall back if killing failed.
			explicit: requested.explicit || !!options.force,
			confirm: !options.force && process.stdin.isTTY && process.stdout.isTTY ? async next => {
				spinner.stop()
				try {
					const { use_next } = await inquirer.prompt([{ type: 'confirm', name: 'use_next',
						message: `Port ${requested.port} or reload port ${requested.port + 1} is in use. Use ${next} for this session?`, default: true }])
					return use_next
				} finally { spinner.start() }
			} : undefined
		})
		if (port !== requested.port) {
			spinner.info(`Port ${requested.port} or reload port ${requested.port + 1} is in use. Using http://localhost:${port} for this session.`)
			spinner.start()
		}
		const runtime = await claim_dev_runtime(base_dir, port)
		const stop_startup_on_interrupt = () => process.exit(130)
		const stop_startup_on_terminate = () => process.exit(143)
		process.once('SIGINT', stop_startup_on_interrupt)
		process.once('SIGTERM', stop_startup_on_terminate)
		let reload_handler: RequestListener | undefined
		const reload_server = http.createServer((req, res) => {
			if (req.method === 'GET' && req.url === '/__primo/runtime') {
				const ready = reload_handler && cms_process?.exitCode === null && cms_process?.signalCode === null
				res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(runtime))
			} else if (reload_handler) {
				reload_handler(req, res)
			} else {
				res.writeHead(503)
				res.end('Primo is starting')
			}
		})
		// Reserve reload before starting the CMS or importing any files. A bind
		// race fails startup rather than leaving a partially working session.
		await new Promise<void>((resolve, reject) => {
			reload_server.once('error', reject)
			reload_server.listen(port + 1, '127.0.0.1', () => {
				reload_server.removeListener('error', reject)
				resolve()
			})
		})

		if (is_server_mode) {
			// Auto-discover sites in subdirectories
			spinner.text = 'Discovering sites...'
			sites = await discover_sites(base_dir)
			// Sites can be empty - the dashboard will show the site creation screen
		} else {
			// Single site mode
			try {
				const config = await read_site_config(base_dir)
				if (typeof config.site_id !== 'string' || !config.site_id.trim()) {
					// Without a site_id the import posts site_id=undefined and
					// fails cryptically — stop with the actual fix instead.
					spinner.fail(`${SITE_CONFIG_FILE} has no site_id — this site was never registered.`)
					console.log(chalk.dim(`  Run \`primo add ${path.basename(base_dir)}\` from the workspace root to register it.`))
					process.exit(1)
				}
				sites = [{ dir: base_dir, config }]
			} catch {
				spinner.fail(`No ${SERVER_CONFIG_FILE} or ${SITE_CONFIG_FILE} found. Run \`primo new\` first.`)
				process.exit(1)
			}
		}

		// Ensure binary is installed
		spinner.text = 'Checking primo...'
		const binary_path = await ensure_binary()

		// Create data directory in project folder
		const data_dir = await ensure_data_dir(base_dir)

		spinner.text = 'Starting CMS...'

		// Start the CMS binary with dev mode enabled. PRIMO_AUTHOR_MODE
		// tells primo which sync mode the CLI is running in so the CMS
		// UI can gate its editable surfaces accordingly (read-only when
		// the CLI is in --author files, since CMS edits would be discarded
		// before they ever round-trip to disk).
		cms_process = spawn(binary_path, ['serve', '--http', `127.0.0.1:${port}`, '--dir', data_dir], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, PRIMO_DEV_MODE: '1', PRIMO_AUTHOR_MODE: sync_policy.mode }
		})

		let cms_start_error: Error | null = null
		cms_process.on('error', error => { cms_start_error = error })
		process.once('exit', () => { cms_process?.kill('SIGTERM') })
		if (cms_process.pid) await record_cms_process(base_dir, runtime, cms_process.pid)

		// Capture stderr for errors
		let stderr_output = ''
		cms_process.stderr?.on('data', (data) => {
			stderr_output += data.toString()
		})

		// Wait for CMS to be ready
		const ready = await wait_for_ready(`http://127.0.0.1:${port}`, 30000)
		if (!ready || cms_start_error || cms_process.exitCode !== null || cms_process.signalCode !== null) {
			spinner.fail('CMS failed to start')
			if (stderr_output) {
				console.log(chalk.red(stderr_output))
			}
			process.exit(1)
		}

			const api_url = `http://127.0.0.1:${port}`
			// Stamped into every sync_status.json write so an agent reading the
			// file also learns where the running server is.
			const dev_location: DevLocation = { port, url: api_url }

			if (is_server_mode) {
				spinner.text = sync_policy.mode === 'cms' ? 'Pulling shared library...' : 'Loading shared library...'
				is_importing_library = true
				try {
					if (sync_policy.mode === 'cms') {
						await sync_library_from_cms(base_dir, api_url)
					} else {
						await import_library_files(base_dir, api_url)
					}
				} finally {
					is_importing_library = false
				}
			}

			// Normalize and load all sites
			spinner.text = `Loading ${sites.length} site${sites.length > 1 ? 's' : ''}...`

			const blocked_sites = new Set<string>()
			let dropped_field_count = 0
			for (const site of sites) {
				const use_bootstrap = !await site_exists(api_url, site.config.site_id)
				if (sync_policy.mode === 'cms' && !use_bootstrap) {
					await sync_from_cms(site.dir, api_url, site.config, server_config, base_dir, sync_policy)
					continue
				}

				await normalize_site(site.dir)
				const site_key = get_site_sync_key(site.dir, site.config)
				const import_timings = await with_site_import_lock(site.dir, site.config, () => import_site_files(site.dir, api_url, site.config, port, server_config, use_bootstrap, base_dir))
				if (import_timings === null) {
					// Duplicate _ids — nothing was pushed; the watcher retries
					// once the user removes a conflicting file. Quarantine it so
					// CMS→file polling doesn't sync into an out-of-sync site.
					blocked_sites.add(site.dir)
					blocked_site_keys.add(site_key)
					continue
				}
				// Write sync_status.json on boot too — otherwise an agent reading
				// right after `primo dev` starts sees stale/absent state, and any
				// dropped fields from the initial import stay invisible until the
				// next file save. Writes ok:false when the import didn't land.
				await write_import_sync_status(site.dir, import_timings, dev_location)
				if (!import_timings.ok) {
					// Bootstrap and its regular-import fallback both failed (only
					// logged, not thrown). Keep the site quarantined and skip the
					// baseline/success path so we don't record a phantom import.
					blocked_sites.add(site.dir)
					blocked_site_keys.add(site_key)
					continue
				}
				blocked_site_keys.delete(site_key)
				dropped_field_count += import_timings.dropped_field_count
				if (update_site_sync_state_after_import(site, import_timings, sync_policy)) {
					await update_site_sync_baseline(site, api_url, server_config, base_dir)
				}
			}

		// Verify all sites are accessible before proceeding
		spinner.text = 'Verifying sites...'
		for (const site of sites) {
			if (blocked_sites.has(site.dir)) continue
			await verify_site_ready(api_url, site.config.site_id)
		}

		spinner.succeed('Primo running')

		// Restate any dropped-field warnings next to the banner. The per-field
		// detail already printed above during import, but on a multi-site or
		// long boot it scrolls out of view and the green banner reads as
		// "all good" — so surface the aggregate here as the last thing on
		// screen. See print_import_warnings for the full per-field output.
		if (dropped_field_count > 0) {
			console.log('')
			console.log(chalk.yellow(`  ⚠ ${dropped_field_count} field${dropped_field_count === 1 ? '' : 's'} dropped — content not imported (see warnings above)`))
		}

		console.log('')
		if (mcp_registration_path) {
			console.log(`  ${chalk.dim(`MCP server registered at ${mcp_registration_path} - agents in this directory can now use the Primo MCP server.`)}`)
			console.log('')
		}
		if (is_server_mode) {
			console.log(`  ${chalk.cyan('Dashboard:')} http://127.0.0.1:${port}/admin/dashboard`)
			console.log('')
		}
		for (const site of sites) {
			const host = local_dev_host(site.config.name, port)
			console.log(`  ${chalk.cyan(site.config.name)}`)
			console.log(`    ${chalk.dim('Edit:')}    http://${host}/admin/site`)
			console.log(`    ${chalk.dim('Preview:')} http://${host}/`)
		}
		if (sites.length > 0 || !is_server_mode) {
			console.log('')
		}

			// Start watching for file changes. `uploads` is included so dropping
			// an image into uploads/ triggers a push — the server-side reconcile
			// creates a site_uploads record for it and the writeback renames
			// the local file to the canonical (suffixed) name.
			const dirs_to_watch = ['blocks', 'page-types', 'pages', 'site', 'uploads']
			const known_sites = new Set(sites.map(s => s.dir))

			if (is_server_mode) {
				const library_path = path.join(base_dir, LIBRARY_DIR)
				// Prime the snapshot from the current disk state so the first
				// post-startup push doesn't consider every existing folder as
				// a potential delete.
				library_snapshot = await scan_library_folders(library_path)

				try {
					const watcher = chokidar.watch(library_path, {
						ignored: (p: string) => path.basename(p).startsWith('.'),
						ignoreInitial: true,
						awaitWriteFinish: {
							stabilityThreshold: 60,
							pollInterval: 30
						}
					})
					const log_library_push_paused = (full_path: string) => {
						const filename = path.relative(library_path, full_path)
						console.log(chalk.dim(`  library: ${filename} ignored (file→CMS paused by --author cms)`))
					}
					const push_or_ignore_library_change = (full_path: string) => {
						if (!is_file_to_cms_active(sync_policy)) {
							log_library_push_paused(full_path)
							return
						}

						// Mark pending synchronously so the sync interval cannot
						// sneak a pull through between the event and push.
						const was_pending = has_pending_library_local_changes
						has_pending_library_local_changes = true
						last_local_change_time = Date.now()
						if (!was_pending && sync_policy.mode === 'both') {
							console.log(chalk.dim('  library: CMS-to-file sync paused while local import is pending.'))
						}
						schedule_library_push()
					}
					const on_event = (event: WatchEvent, full_path: string) => {
						if (should_skip_synced_delete(full_path, event)) return

						if (synced_files.has(full_path)) {
							// We last wrote this file from a CMS pull. If the
							// content on disk still matches our write, the
							// chokidar event is just our own write echoing
							// back — drop it. If it differs, the user edited
							// the file (possibly very shortly after our pull
							// landed) and we must push.
							event_matches_synced_write(full_path)
								.then(matches => {
									synced_files.delete(full_path)
									if (matches) return
									push_or_ignore_library_change(full_path)
								})
								.catch(() => {
									synced_files.delete(full_path)
									push_or_ignore_library_change(full_path)
								})
							return
						}
						push_or_ignore_library_change(full_path)
					}

					const schedule_library_push = () => {
						if (library_reimport_timeout) clearTimeout(library_reimport_timeout)
						library_reimport_timeout = setTimeout(async () => {
							if (is_importing) {
								// Re-arm; another push is in-flight.
								schedule_library_push()
								return
							}
							try {
								is_importing = true
								is_importing_library = true

								// Diff current disk state against the last snapshot to
								// compute the deletes manifest. Only paths present in
								// the snapshot but absent on disk right now are real
								// user deletions. Race-free: we read disk AFTER the
								// debounce has settled.
								const current = await scan_library_folders(library_path)
								const delete_group_ids: string[] = []
								const delete_symbol_ids: string[] = []
								const delete_paths: string[] = []
								for (const [snap_path, entry] of library_snapshot) {
									if (current.has(snap_path)) continue
									delete_paths.push(snap_path)
									if (entry.id) {
										if (entry.kind === 'group') delete_group_ids.push(entry.id)
										else delete_symbol_ids.push(entry.id)
									}
								}
								delete_paths.sort()
								if (delete_paths.length > 0) {
									console.log(chalk.yellow(`  library: deleting ${delete_paths.length} path(s): ${delete_paths.join(', ')}`))
								}

								const import_timings = await import_library_files(base_dir, api_url, delete_group_ids, delete_symbol_ids)
								const reload_started = Date.now()
								await request_browser_reload(api_url)
								const reload_ms = Date.now() - reload_started
								has_pending_library_local_changes = false
								if (sync_policy.mode === 'both') {
									console.log(chalk.dim('  library: CMS-to-file sync resumed.'))
								}
								// Update snapshot only on successful push.
								library_snapshot = current
								console.log(chalk.dim(`  library: zip ${import_timings.zip_ms}ms, import ${import_timings.request_ms}ms, reload ${reload_ms}ms`))
								console.log(chalk.green('  ✓ Library pushed'))
							} catch (err) {
								console.log(chalk.red(`  ✗ Library push failed: ${err}`))
							} finally {
								is_importing_library = false
								is_importing = false
								last_import_time = Date.now()
							}
						}, LOCAL_PUSH_DEBOUNCE_MS)
					}

					watcher.on('add', p => on_event('add', p))
					watcher.on('change', p => on_event('change', p))
					watcher.on('unlink', p => on_event('unlink', p))
					watcher.on('addDir', p => on_event('addDir', p))
					watcher.on('unlinkDir', p => on_event('unlinkDir', p))
					watchers.push(watcher)
				} catch {
					// Library directory might not exist
				}
			}

			const setup_site_watchers = (site: SiteInfo) => {
				let pending_reload = false

				const schedule_reimport = () => {
					if (reimport_timeout) {
						clearTimeout(reimport_timeout)
					}
					reimport_timeout = setTimeout(async () => {
						// If already importing, reschedule and wait
						if (is_importing) {
							schedule_reimport()
							return
						}
						try {
							is_importing = true
							const normalize_started = Date.now()
							await normalize_site(site.dir)
							const normalize_ms = Date.now() - normalize_started
							let conflict_paths: string[] = []
							if (sync_policy.mode === 'both') {
								try {
									conflict_paths = await detect_site_file_push_conflicts(site, api_url, server_config, base_dir)
								} catch {
									// Conflict detection must not block the local push.
								}
							}
							// Steady-state pushes go through the additive import
							// endpoint (use_bootstrap=false). But a site whose initial
							// bootstrap+fallback both failed is quarantined and was
							// never created on the server — retrying import against a
							// nonexistent site would fail forever. For those, re-check
							// existence so the retry can bootstrap out of quarantine.
							// Healthy sites are never quarantined, so they skip the
							// extra request and keep the fast path.
							const retry_needs_bootstrap = blocked_site_keys.has(get_site_sync_key(site.dir, site.config))
								? !await site_exists(api_url, site.config.site_id)
								: false
							const import_timings = await with_site_import_lock(site.dir, site.config, () => import_site_files(site.dir, api_url, site.config, port, server_config, retry_needs_bootstrap, base_dir))
							if (import_timings === null) {
								// Duplicate _ids — import_site_files already printed the
								// error and wrote sync_status; nothing was pushed. Keep
								// the site quarantined from CMS→file polling.
								blocked_site_keys.add(get_site_sync_key(site.dir, site.config))
								return
							}
							// Import succeeded — lift any prior quarantine.
							blocked_site_keys.delete(get_site_sync_key(site.dir, site.config))
							let reload_ms = 0
							if (pending_reload) {
								try {
									const reload_started = Date.now()
									await request_browser_reload(api_url)
									reload_ms = Date.now() - reload_started
								} catch {
									console.log(chalk.yellow(`  Warning: Failed to trigger browser reload for ${site.config.name}`))
								}
								pending_reload = false
							}
							if (conflict_paths.length > 0) {
								if (import_timings.warning_count > 0) {
									log_sync_conflict(site.config.name, 'unresolved', 'file push completed with import warnings; CMS-to-file sync paused until resolved', conflict_paths)
								} else {
									log_sync_conflict(site.config.name, 'files', 'both sides changed since last sync; local push was applied (CMS values from last poll were discarded)', conflict_paths)
								}
							}
							if (update_site_sync_state_after_import(site, import_timings, sync_policy)) {
								await update_site_sync_baseline(site, api_url, server_config, base_dir)
							}
							console.log(chalk.dim(`  ${site.config.name}: normalize ${normalize_ms}ms, zip ${import_timings.zip_ms}ms, ${import_timings.mode} ${import_timings.request_ms}ms${reload_ms ? `, reload ${reload_ms}ms` : ''}`))
							console.log(chalk.green(`  ✓ ${site.config.name} pushed`))
							await write_import_sync_status(site.dir, import_timings, dev_location)
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err)
							console.log(chalk.red(`  ✗ ${site.config.name} push failed: ${message}`))
							await write_sync_status(site.dir, {
								ok: false,
								error: message,
								failed_at: new Date().toISOString()
							}, dev_location)
						} finally {
							is_importing = false
							last_import_time = Date.now()  // Track when import finished
						}
					}, LOCAL_PUSH_DEBOUNCE_MS)
				}

				for (const dir of dirs_to_watch) {
					const watch_path = path.join(site.dir, dir)
					try {
						const watcher = chokidar.watch(watch_path, {
							ignored: (p: string) => path.basename(p).startsWith('.'),
							ignoreInitial: true,
							awaitWriteFinish: {
								stabilityThreshold: 60,
								pollInterval: 30
							}
						})
						const continue_event = (full_path: string) => {
							const filename = path.relative(watch_path, full_path)
							console.log(chalk.dim(`  ${site.config.name}: ${dir}/${filename}`))
							if (change_requires_reload(dir, filename)) {
								pending_reload = true
							}
							schedule_reimport()
						}
						const mark_pending_local_change = () => {
							const site_key = get_site_sync_key(site.dir, site.config)
							const was_pending = pending_local_site_keys.has(site_key)
							pending_local_site_keys.add(site_key)
							last_local_change_time = Date.now()
							if (!was_pending && sync_policy.mode === 'both') {
								console.log(chalk.dim(`  ${site.config.name}: CMS-to-file sync paused while local import is pending.`))
							}
						}
						const log_file_push_paused = (full_path: string) => {
							const filename = path.relative(watch_path, full_path)
							console.log(chalk.dim(`  ${site.config.name}: ${dir}/${filename} ignored (file→CMS paused by --author cms)`))
						}
						const push_or_ignore_file_change = (full_path: string) => {
							if (!is_file_to_cms_active(sync_policy)) {
								log_file_push_paused(full_path)
								return
							}

							// Mark site as pending synchronously so the sync interval
							// cannot pull against a site that's actively being edited.
							mark_pending_local_change()
							continue_event(full_path)
						}
						const on_event = (event: WatchEvent, full_path: string) => {
							if (should_skip_synced_delete(full_path, event)) return

							if (synced_files.has(full_path)) {
								// We last wrote this file from a CMS pull. Compare
								// the file's *current* content against the hash we
								// stored: if identical, this watcher event is the
								// echo of our own write and must be ignored; if
								// different, the user edited the file (possibly
								// within ms of our pull) and the edit must push,
								// which is exactly the case the old mtime-tolerance
								// check used to swallow for site/head.svelte.
								event_matches_synced_write(full_path)
									.then(matches => {
										synced_files.delete(full_path)
										if (matches) return
										push_or_ignore_file_change(full_path)
									})
									.catch(() => {
										synced_files.delete(full_path)
										push_or_ignore_file_change(full_path)
									})
								return
							}
							push_or_ignore_file_change(full_path)
						}
						watcher.on('add', p => on_event('add', p))
						watcher.on('change', p => on_event('change', p))
						watcher.on('unlink', p => on_event('unlink', p))
						watcher.on('addDir', p => on_event('addDir', p))
						watcher.on('unlinkDir', p => on_event('unlinkDir', p))
						watchers.push(watcher)
					} catch {
						// Directory might not exist
					}
				}
			}

		// Set up watchers for existing sites
		for (const site of sites) {
			setup_site_watchers(site)
		}

		// Enable reload once initial imports and watchers are ready.
		{
			reload_handler = async (req, res) => {
				if (!is_server_mode || req.method !== 'POST' || req.url !== '/reload') {
					res.writeHead(404)
					res.end()
					return
				}

				const new_sites = await discover_sites(base_dir)
				let loaded_count = 0
				const quarantined: string[] = []
				for (const site of new_sites) {
					if (known_sites.has(site.dir)) continue

					known_sites.add(site.dir)
					sites.push(site)
					let import_ok = true
					try {
						const use_bootstrap = !await site_exists(api_url, site.config.site_id)
						if (sync_policy.mode === 'cms' && !use_bootstrap) {
							await sync_from_cms(site.dir, api_url, site.config, server_config, base_dir, sync_policy)
						} else {
							await normalize_site(site.dir)
							const import_timings = await with_site_import_lock(site.dir, site.config, () => import_site_files(site.dir, api_url, site.config, port, server_config, use_bootstrap, base_dir))
							if (import_timings === null) {
								// Duplicate _ids on a freshly discovered site — quarantine
								// it from CMS→file polling until a later import succeeds.
								blocked_site_keys.add(get_site_sync_key(site.dir, site.config))
								quarantined.push(site.config.name)
								import_ok = false
							} else {
								await write_import_sync_status(site.dir, import_timings, dev_location)
								if (!import_timings.ok) {
									// Bootstrap + fallback both failed (only logged). Quarantine
									// and skip the success path so we don't announce a site that
									// didn't actually load — and so `primo new` sees it in the
									// /reload body's `quarantined` list.
									blocked_site_keys.add(get_site_sync_key(site.dir, site.config))
									quarantined.push(site.config.name)
									import_ok = false
								} else if (update_site_sync_state_after_import(site, import_timings, sync_policy)) {
									await update_site_sync_baseline(site, api_url, server_config, base_dir)
								}
							}
						}
					} catch (err) {
						// A malformed site (e.g. missing pages/index.yaml, which makes
						// normalize_site throw) must not take the whole dev server down:
						// before this guard, the throw escaped the handler as an
						// unhandledRejection and tripped process-level cleanup().
						// Quarantine the site and keep serving; the watcher retries it
						// on the next file change.
						blocked_site_keys.add(get_site_sync_key(site.dir, site.config))
						quarantined.push(site.config.name)
						import_ok = false
						const message = err instanceof Error ? err.message : String(err)
						console.log(chalk.red(`  ✗ ${site.config.name}: ${message}`))
					}
					setup_site_watchers(site)
					loaded_count++

					if (!import_ok) {
						console.log(chalk.yellow(`  ⚠ ${site.config.name}: import failed — see logs; will retry on the next file change.`))
						continue
					}

					const host = local_dev_host(site.config.name || path.basename(site.dir), port)
					console.log(chalk.green(`  ✓ New site loaded: ${site.config.name}`))
					console.log(`    ${chalk.dim('Edit:')}    http://${host}/admin/site`)
					console.log(`    ${chalk.dim('Preview:')} http://${host}/`)
				}

				// Report the outcome so `primo new` can tell whether the site it
				// just scaffolded actually imported. A quarantined site (duplicate
				// _ids) returns 200 with loaded:false so a 2xx no longer implies
				// success — the caller checks the body, not just the status.
				// `known` lists every site this server tracks so `primo add` can
				// tell "already registered here" from "this server is serving a
				// different workspace" — record-level reads can't make that call
				// (PocketBase 404s them pre-setup even when the record exists).
				const body = JSON.stringify({
					loaded: loaded_count,
					quarantined,
					known: sites.map(site => ({
						name: site.config.name,
						site_id: site.config.site_id,
						blocked: blocked_site_keys.has(get_site_sync_key(site.dir, site.config))
					}))
				})
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(body)
			}
		}

		// Start polling for CMS changes (sync back to local files)
		// Wait 3 seconds after import to avoid overwriting just-pushed changes
		const IMPORT_COOLDOWN_MS = 3000
		if (is_cms_to_file_active(sync_policy)) {
			sync_interval = setInterval(async () => {
				if (is_syncing || is_importing) return
				if (Date.now() - last_import_time < IMPORT_COOLDOWN_MS) return
				// Skip the pull if the user just made a local change — otherwise a
				// pull that started before the watcher fired could overwrite the
				// fresh local edit on arrival.
				if (Date.now() - last_local_change_time < LOCAL_CHANGE_PULL_COOLDOWN_MS) return

				is_syncing = true
				try {
					for (const site of sites) {
						try {
							const site_key = get_site_sync_key(site.dir, site.config)
							if (
								importing_site_keys.has(site_key) ||
								pending_local_site_keys.has(site_key) ||
								blocked_site_keys.has(site_key)
							) {
								continue
							}
							await sync_from_cms(site.dir, api_url, site.config, server_config, base_dir, sync_policy)
						} catch {
							// Silently ignore sync errors
						}
					}
					if (is_server_mode && !is_importing_library && !has_pending_library_local_changes && await has_library_content(path.join(base_dir, LIBRARY_DIR))) {
						try {
							await sync_library_from_cms(base_dir, api_url)
						} catch {
							// Silently ignore library sync errors
						}
					}
				} finally {
					is_syncing = false
				}
			}, 1000)
		}

		print_sync_status(sync_policy, sites)
		console.log(chalk.dim('  Press Ctrl+C to stop'))

		// Handle cleanup
		const cleanup = async () => {
			if (is_cleaning_up) {
				// Second Ctrl-C while we're still cleaning up — bail immediately
				// so the user isn't stuck waiting on an in-flight push/sync.
				console.log(chalk.dim('\n  Force exit'))
				process.exit(130)
			}
			is_cleaning_up = true

			console.log(chalk.dim('\n  Shutting down...'))

			for (const watcher of watchers) {
				try {
					watcher.close()
				} catch {
					// Ignore watcher close errors
				}
			}
			watchers = []

				if (reimport_timeout) {
					clearTimeout(reimport_timeout)
					reimport_timeout = null
				}
				if (library_reimport_timeout) {
					clearTimeout(library_reimport_timeout)
					library_reimport_timeout = null
				}
				if (sync_interval) {
					clearInterval(sync_interval)
					sync_interval = null
			}
			if (cms_process) {
				await kill_process(cms_process)
				cms_process = null
			}
			process.exit(0)
		}

		process.removeListener('SIGINT', stop_startup_on_interrupt)
		process.removeListener('SIGTERM', stop_startup_on_terminate)
		process.on('SIGINT', cleanup)
		process.on('SIGTERM', cleanup)
		process.on('uncaughtException', (err) => {
			console.error(chalk.red(`\n  Uncaught exception: ${err.message}`))
			cleanup()
		})
		process.on('unhandledRejection', (reason) => {
			console.error(chalk.red(`\n  Unhandled rejection: ${reason}`))
			cleanup()
		})

		// Keep process alive
		await new Promise(() => {})

	} catch (error) {
		spinner.fail(`Failed to start: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}
}

async function register_primo_mcp_server(base_dir: string): Promise<string | null> {
	if (!await path_exists(path.join(base_dir, SERVER_CONFIG_FILE))) {
		return null
	}

	const mcp_config_path = path.join(base_dir, MCP_CONFIG_FILE)
	let config: Record<string, unknown> = {}

	try {
		const raw = await fs.readFile(mcp_config_path, 'utf-8')
		config = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			return null
		}
	}

	if (!is_plain_record(config)) {
		return null
	}

	if (config.mcpServers !== undefined && !is_plain_record(config.mcpServers)) {
		return null
	}

	const existing_mcp_servers = config.mcpServers as Record<string, unknown> | undefined
	const mcp_servers = { ...(existing_mcp_servers ?? {}) }
	if (mcp_servers.primo !== undefined) {
		return null
	}

	// Default to the published package; PRIMO_MCP_LOCAL opts into a local dist build.
	const local_mcp = process.env.PRIMO_MCP_LOCAL
	mcp_servers.primo = local_mcp
		? { command: 'node', args: [local_mcp] }
		: { command: 'npx', args: ['-y', 'primo-mcp'] }
	config.mcpServers = mcp_servers

	// Claude Code reads project-root .mcp.json. .primo/ is gitignored local
	// state, so the discoverable root file is the right registration target.
	await fs.writeFile(mcp_config_path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
	return MCP_CONFIG_FILE
}

function is_plain_record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

// Folders that already got their unregistered/unreadable warning, so
// rediscovery (which runs on every /reload) doesn't repeat it.
const warned_unregistered_dirs = new Set<string>()

// Site-shaped = has any of the content dirs a real site carries. Used to
// tell an authored-but-unregistered site (warn) from a random folder that
// happens to live under sites/ (ignore silently, as before).
async function is_site_shaped(site_dir: string): Promise<boolean> {
	for (const marker of ['pages', 'blocks', 'page-types', 'site']) {
		try {
			// Must be a directory — a plain file named e.g. `pages` in a
			// non-site folder shouldn't earn the unregistered warning.
			const stat = await fs.stat(path.join(site_dir, marker))
			if (stat.isDirectory()) return true
		} catch {
			// keep looking
		}
	}
	return false
}

function warn_once(site_dir: string, message: string): void {
	if (warned_unregistered_dirs.has(site_dir)) return
	warned_unregistered_dirs.add(site_dir)
	console.log(chalk.yellow(message))
}

async function discover_sites(base_dir: string): Promise<SiteInfo[]> {
	const sites: SiteInfo[] = []
	const sites_root = await get_sites_root(base_dir)
	const entries = await fs.readdir(sites_root, { withFileTypes: true })

	for (const entry of entries) {
		if (entry.isDirectory() && !entry.name.startsWith('.')) {
			const site_dir = path.join(sites_root, entry.name)
			try {
				const config = await read_site_config(site_dir)
				if (typeof config.site_id !== 'string' || !config.site_id.trim()) {
					// An authored site with no registration key. Importing it
					// would post site_id=undefined and die with a buried
					// error, so skip it and say what to run instead.
					warn_once(site_dir, `  ⚠ sites/${entry.name} isn't registered — run \`primo add ${entry.name}\` to import it.`)
					continue
				}
				sites.push({ dir: site_dir, config })
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					// No site.yaml. Only warn when the folder actually looks
					// like a site — anything else is not our business.
					if (await is_site_shaped(site_dir)) {
						warn_once(site_dir, `  ⚠ sites/${entry.name} isn't registered — run \`primo add ${entry.name}\` to import it.`)
					}
				} else {
					warn_once(site_dir, `  ⚠ sites/${entry.name}/site.yaml could not be read — fix it, then run \`primo add ${entry.name}\`.`)
				}
			}
		}
	}

	return sites
}

async function get_sites_root(base_dir: string): Promise<string> {
	const candidate = path.join(base_dir, SITES_DIR)
	try {
		const stat = await fs.stat(candidate)
		if (stat.isDirectory()) {
			return candidate
		}
	} catch {
		// Missing sites/ directory
	}

	throw new Error(`Server workspace is missing ${SITES_DIR}/. Run \`primo new\` from the workspace root or create ${SITES_DIR}/ first.`)
}

// Group-id notices are educational and would otherwise repeat on every import
// (the dev watcher re-imports on file changes), so show each once per process.
const group_notices_shown = new Set<string>()

function resolve_site_group(config: SiteConfig, server_config: ServerConfig): SiteGroupConfig {
	const configured_groups = server_config.site_groups ?? []
	const group_ref = config.group?.trim()

	const notice = group_id_notice(group_ref, configured_groups)
	if (notice && !group_notices_shown.has(notice)) {
		group_notices_shown.add(notice)
		console.log(chalk.yellow(`  ${notice}`))
	}

	const ensure_group_id = (group: SiteGroupConfig): SiteGroupConfig => ({
		...group,
		id: typeof group.id === 'string' && group.id.trim().length >= 15 ? group.id.trim() : generate_id()
	})

	if (group_ref) {
		const existing_group = configured_groups.find((group) => group.id === group_ref || group.name === group_ref)
		if (existing_group) {
			return ensure_group_id(existing_group)
		}

		return ensure_group_id({
			id: group_ref,
			name: format_group_name(group_ref),
			index: configured_groups.length
		})
	}

	if (configured_groups[0]) {
		return ensure_group_id(configured_groups[0])
	}

	return ensure_group_id({
		id: '',
		name: 'Default',
		index: 0
	})
}

/**
 * The server assigns group ids on import (its store regenerates any id it
 * considers invalid), so the id in `server.yaml` is only a local reference.
 * When the server tells us the id it actually stored, write it back so the
 * files and the database agree. Older servers don't return one — then this is
 * a no-op and `group_id_notice` explains the drift instead.
 *
 * Best-effort: an import must never fail because writeback did.
 */
export async function apply_server_group_id(
	server_group_id: string,
	site_dir: string,
	config: SiteConfig,
	server_config: ServerConfig,
	workspace_dir: string
): Promise<void> {
	if (!server_group_id) return

	const configured = server_config.site_groups ?? []
	const ref = config.group?.trim()
	const target = configured.find((group) => group.id === ref || group.name === ref) ?? configured[0]
	if (!target || target.id === server_group_id) return

	try {
		server_config.site_groups = configured.map((group) =>
			group === target ? { ...group, id: server_group_id } : group
		)
		await write_server_config(workspace_dir, server_config)

		// Only rewrite site.yaml when it referenced the group by its old id.
		// A name reference stays a name — names are the stable key.
		if (ref && ref === target.id) {
			config.group = server_group_id
			await write_site_config(site_dir, config)
		}

		console.log(chalk.dim(`  group "${target.name}": server id ${server_group_id} (was ${target.id}); updated ${SERVER_CONFIG_FILE}`))
	} catch {
		// Best-effort — never fail an import over writeback.
	}
}

export async function wait_for_ready(url: string, timeout_ms: number): Promise<boolean> {
	const start = Date.now()
	const health_url = `${url}/api/health`

	while (Date.now() - start < timeout_ms) {
		try {
			const response = await fetch_with_timeout(health_url, {}, 2000)
			if (response.ok) {
				// Health check passed, but collections may not be ready yet
				// Give PocketBase a moment to finish initializing
				await new Promise(resolve => setTimeout(resolve, 500))
				return true
			}
		} catch {
			// Server not ready yet
		}
		await new Promise(resolve => setTimeout(resolve, 100))
	}

	return false
}

async function verify_site_ready(api_url: string, site_id: string): Promise<boolean> {
	const max_attempts = 20
	const delay_ms = 100

	for (let i = 0; i < max_attempts; i++) {
		try {
			const response = await fetch_with_timeout(`${api_url}/api/collections/sites/records/${site_id}`, {}, 5000)
			if (response.ok) {
				return true
			}
		} catch {
			// Site not ready yet
		}
		await new Promise(resolve => setTimeout(resolve, delay_ms))
	}

	return false
}

// Dev-auth tokens are per server and stable for a process run; cache so a
// dev loop with many sites doesn't re-mint one per site.
const dev_token_cache = new Map<string, string>()

/** Fetch a local dev token; null when the server doesn't offer one. */
async function dev_auth_token(api_url: string): Promise<string | null> {
	const cached = dev_token_cache.get(api_url)
	if (cached) return cached
	try {
		const response = await fetch_with_timeout(`${api_url}/api/primo/dev-auth`, { method: 'POST' }, 2000)
		if (!response.ok) return null
		const body = (await response.json()) as { token?: string }
		if (!body.token) return null
		dev_token_cache.set(api_url, body.token)
		return body.token
	} catch {
		return null
	}
}

export async function site_exists(api_url: string, site_id: string): Promise<boolean> {
	// The collections API is auth-gated: without a token, reading a specific
	// record returns 404 even when it exists — which would send `primo add`
	// (and dev's import path) down the destructive `bootstrap` path for an
	// already-registered site. Authenticate with a local dev token first.
	//
	// With a token, 404 is authoritative. Any other non-ok status (5xx, rate
	// limits) is still uncertain — default to "exists" so we take the additive
	// `import` path rather than bootstrap. Bootstrapping a site that already
	// exists discards remote state when the request later fails, and the next
	// pull then stomps in-progress local edits with stale DB content.
	try {
		const headers: Record<string, string> = {}
		const token = await dev_auth_token(api_url)
		if (token) headers.Authorization = token
		const response = await fetch_with_timeout(`${api_url}/api/collections/sites/records/${site_id}`, { headers }, 5000)
		if (response.ok) return true
		if (response.status === 404) return false
		return true
	} catch {
		return true
	}
}

function change_requires_reload(_dir: string, _filename: string): boolean {
	return true
}

async function request_browser_reload(api_url: string): Promise<void> {
	await fetch_with_timeout(`${api_url}/api/primo/dev/reload`, {
		method: 'POST'
	}, 5000)
}

function generate_id(length = 15): string {
	let id = ''
	for (let i = 0; i < length; i++) {
		id += ID_ALPHABET[randomInt(ID_ALPHABET.length)]
	}
	return id
}

function get_entity_id(value: unknown): string | undefined {
	if (!value || typeof value !== 'object') return undefined
	const record = value as { _id?: unknown; id?: unknown }
	if (typeof record._id === 'string' && record._id) return record._id
	if (typeof record.id === 'string' && record.id) return record.id
	return undefined
}

function get_fields_array(data: unknown): Record<string, unknown>[] {
	if (Array.isArray(data)) {
		return data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
	}

	if (data && typeof data === 'object' && Array.isArray((data as { fields?: unknown[] }).fields)) {
		return (data as { fields: unknown[] }).fields
			.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
	}

	return []
}

function get_sections_array(data: unknown): Record<string, unknown>[] {
	if (!Array.isArray(data)) {
		return []
	}

	return data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

function collect_field_ids(fields: Record<string, unknown>[], visit: (field_id: string) => void) {
	for (const field of fields) {
		const field_id = get_entity_id(field)
		if (field_id) {
			visit(field_id)
		}

		if (Array.isArray(field.subfields)) {
			const subfields = field.subfields.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
			collect_field_ids(subfields, visit)
		}
	}
}

function track_duplicate(
	duplicates: Map<IDCategory, Map<string, DuplicateOccurrence[]>>,
	category: IDCategory,
	id: string,
	occurrence: DuplicateOccurrence
) {
	let by_id = duplicates.get(category)
	if (!by_id) {
		by_id = new Map<string, DuplicateOccurrence[]>()
		duplicates.set(category, by_id)
	}

	const existing = by_id.get(id) ?? []
	existing.push(occurrence)
	by_id.set(id, existing)
}

function mark_written_file(file_path: string, content: string | Buffer) {
	synced_files.set(file_path, hash_content(content))
}

function mark_deleted_path(file_path: string) {
	synced_deleted_paths.set(file_path, Date.now())
}

// Only a delete event can be the echo of a sync-initiated delete. An `add`
// (or `change`) for a path we recently deleted is a genuine re-creation — the
// user (or an agent) put the file back — and MUST NOT be skipped, or the new
// file silently never imports. This is exactly the bug where a re-created
// page-types/default/head.svelte sat outside the CMS while sibling sites
// imported: the create landed inside the 10s synced-delete window and was
// swallowed. So we gate the skip on the event being a delete.
type WatchEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

function is_delete_event(event: WatchEvent): boolean {
	return event === 'unlink' || event === 'unlinkDir'
}

function should_skip_synced_delete(file_path: string, event: WatchEvent): boolean {
	const deleted_at = synced_deleted_paths.get(file_path)
	if (!deleted_at) {
		return false
	}

	// A re-creation cancels the pending delete-echo suppression and must be
	// allowed through to import. Clear the marker so a later real delete of the
	// same path isn't mistaken for our echo.
	if (!is_delete_event(event)) {
		synced_deleted_paths.delete(file_path)
		return false
	}

	if (Date.now() - deleted_at < 10_000) {
		synced_deleted_paths.delete(file_path)
		return true
	}

	synced_deleted_paths.delete(file_path)
	return false
}

async function mark_deleted_tree(root_path: string): Promise<void> {
	mark_deleted_path(root_path)

	let entries
	try {
		entries = await fs.readdir(root_path, { withFileTypes: true })
	} catch {
		return
	}

	for (const entry of entries) {
		await mark_deleted_tree(path.join(root_path, entry.name))
	}
}

async function remove_tracked_path(target_path: string): Promise<void> {
	await mark_deleted_tree(target_path)
	await fs.rm(target_path, { recursive: true, force: true })
}

async function path_exists(target_path: string): Promise<boolean> {
	try {
		await fs.stat(target_path)
		return true
	} catch {
		return false
	}
}

async function find_page_files(dir: string, relative_dir = 'pages'): Promise<string[]> {
	const files: string[] = []

	let entries
	try {
		entries = await fs.readdir(dir, { withFileTypes: true })
	} catch {
		return files
	}

	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue

		const full_path = path.join(dir, entry.name)
		const relative_path = `${relative_dir}/${entry.name}`

		if (entry.isDirectory()) {
			files.push(...await find_page_files(full_path, relative_path))
			continue
		}

		if (entry.name.endsWith('.yaml')) {
			files.push(relative_path)
		}
	}

	return files
}

function to_posix_path(file_path: string): string {
	return file_path.split(path.sep).join('/')
}

function sanitize_file_name(name: string): string {
	return name
		.replaceAll('/', '-')
		.replaceAll('\\', '-')
		.replaceAll(':', '-')
		.replaceAll(' ', '-')
		.toLowerCase()
}

function add_block_alias(aliases: Map<string, string>, alias: string, block_name: string): void {
	const trimmed = alias.trim()
	if (!trimmed) return
	aliases.set(trimmed, block_name)
	aliases.set(trimmed.toLowerCase(), block_name)
	aliases.set(sanitize_file_name(trimmed), block_name)
}

function content_keys(value: unknown): string[] {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return []
	}

	return Object.keys(value as Record<string, unknown>)
}

function is_empty_fields_yaml(contents: string): boolean {
	try {
		const parsed = load_yaml(contents)
		if (parsed == null) return true
		return Array.isArray(parsed) && parsed.length === 0
	} catch {
		return false
	}
}

function is_empty_content_yaml(contents: string): boolean {
	try {
		const parsed = load_yaml(contents)
		if (parsed == null) return true
		if (typeof parsed !== 'object' || Array.isArray(parsed)) return false
		return Object.keys(parsed as Record<string, unknown>).length === 0
	} catch {
		return false
	}
}

function has_user_authored_fields(contents: string): boolean {
	try {
		return get_fields_array(load_yaml(contents)).length > 0
	} catch {
		return false
	}
}

function has_user_authored_content(contents: string): boolean {
	try {
		const parsed = load_yaml(contents)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
		return Object.keys(parsed as Record<string, unknown>).length > 0
	} catch {
		return false
	}
}

function block_fields_path_block_name(relative_path: string): string | null {
	const parts = relative_path.split('/')
	if (parts.length !== 3 || parts[0] !== 'blocks' || parts[2] !== 'fields.yaml') {
		return null
	}
	return parts[1] || null
}

function is_site_fields_path(relative_path: string): boolean {
	return relative_path === 'site/fields.yaml'
}

function is_site_content_path(relative_path: string): boolean {
	return relative_path === 'site/content.yaml'
}

async function collect_block_aliases(site_dir: string): Promise<Map<string, string>> {
	const aliases = new Map<string, string>()
	const blocks_dir = path.join(site_dir, 'blocks')

	let block_names: string[]
	try {
		block_names = await fs.readdir(blocks_dir)
	} catch {
		return aliases
	}

	for (const block_name of block_names) {
		if (block_name.startsWith('.')) continue
		add_block_alias(aliases, block_name, block_name)

		try {
			const raw = await fs.readFile(path.join(blocks_dir, block_name, 'config.yaml'), 'utf-8')
			const parsed = load_yaml(raw)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const display_name = (parsed as Record<string, unknown>).name
				if (typeof display_name === 'string') {
					add_block_alias(aliases, display_name, block_name)
				}
			}
		} catch {
			// Missing or invalid config.yaml should not make sync destructive.
		}
	}

	return aliases
}

async function collect_block_content_references(site_dir: string): Promise<Map<string, BlockContentReference[]>> {
	const refs = new Map<string, BlockContentReference[]>()
	const aliases = await collect_block_aliases(site_dir)
	const pages_dir = path.join(site_dir, 'pages')

	for (const relative_page_path of await find_page_files(pages_dir)) {
		const page_path = path.join(site_dir, relative_page_path)
		let page: unknown
		try {
			page = load_yaml(await fs.readFile(page_path, 'utf-8'))
		} catch {
			continue
		}

		if (!page || typeof page !== 'object' || Array.isArray(page)) continue
		const sections = get_sections_array((page as Record<string, unknown>).sections)
		for (const [index, section] of sections.entries()) {
			const block_ref = section.block
			if (typeof block_ref !== 'string' || !block_ref.trim()) continue

			const keys = content_keys(section.content)
			if (keys.length === 0) continue

			const block_name = aliases.get(block_ref)
				?? aliases.get(block_ref.toLowerCase())
				?? aliases.get(sanitize_file_name(block_ref))
				?? block_ref
			const existing = refs.get(block_name) ?? []
			existing.push({
				page: relative_page_path,
				section_index: index,
				keys
			})
			refs.set(block_name, existing)
		}
	}

	return refs
}

function describe_block_content_refs(refs: BlockContentReference[]): string {
	const details = refs.slice(0, 3).map(ref => {
		const keys = ref.keys.slice(0, 6).join(', ')
		const suffix = ref.keys.length > 6 ? ', ...' : ''
		return `${ref.page} sections[${ref.section_index}] content keys: ${keys}${suffix}`
	})

	if (refs.length > 3) {
		details.push(`${refs.length - 3} more section${refs.length === 4 ? '' : 's'}`)
	}

	return details.join('; ')
}

function warn_empty_schema_writeback(site_name: string, relative_path: string, block_name: string, refs: BlockContentReference[], preserved: boolean): void {
	const key = `${site_name}:${relative_path}:${preserved ? 'preserved' : 'empty'}:${refs.length}`
	if (warned_empty_schema_writebacks.has(key)) return
	warned_empty_schema_writebacks.add(key)

	if (refs.length > 0) {
		console.log(chalk.red(`  ✗ ${site_name}: refused CMS-to-file empty schema writeback for ${relative_path}`))
		console.log(chalk.red(`    Block "${block_name}" has page section content, but the CMS export produced an empty fields.yaml.`))
		console.log(chalk.red(`    ${describe_block_content_refs(refs)}`))
		if (preserved) {
			console.log(chalk.red('    Local fields.yaml was preserved. Re-run the local import or fix the CMS schema before pulling again.'))
		}
		return
	}

	if (preserved) {
		console.log(chalk.yellow(`  ⚠ ${site_name}: skipped empty CMS schema pull for ${relative_path}; local fields.yaml has authored fields.`))
	}
}

function should_skip_empty_block_schema_writeback(relative_path: string, src_content: string, dest_content: string, options: SyncDirectoryOptions): boolean {
	const block_name = block_fields_path_block_name(relative_path)
	if (!block_name || !is_empty_fields_yaml(src_content)) {
		return false
	}

	const refs = options.block_content_refs?.get(block_name) ?? []
	const local_has_fields = has_user_authored_fields(dest_content)
	const should_skip = local_has_fields || refs.length > 0
	if (should_skip) {
		warn_empty_schema_writeback(options.site_name ?? 'site', relative_path, block_name, refs, local_has_fields)
	}
	return should_skip
}

// Symmetric guard for site-level files. The CMS export now always emits
// site/fields.yaml and site/content.yaml (so the on-disk layout documents
// itself), which means a site with no DB-side fields/values would
// otherwise wipe local authored content on every pull. Refuse the
// writeback when the local file has authored content and the incoming
// CMS export is empty.
const warned_empty_site_writebacks = new Set<string>()

function warn_empty_site_writeback(site_name: string, relative_path: string): void {
	const key = `${site_name}:${relative_path}`
	if (warned_empty_site_writebacks.has(key)) return
	warned_empty_site_writebacks.add(key)
	console.log(chalk.yellow(`  ⚠ ${site_name}: skipped empty CMS pull for ${relative_path}; local file has authored content.`))
}

function should_skip_empty_site_writeback(relative_path: string, src_content: string, dest_content: string, options: SyncDirectoryOptions): boolean {
	if (is_site_fields_path(relative_path)) {
		if (!is_empty_fields_yaml(src_content)) return false
		if (!has_user_authored_fields(dest_content)) return false
		warn_empty_site_writeback(options.site_name ?? 'site', relative_path)
		return true
	}
	if (is_site_content_path(relative_path)) {
		if (!is_empty_content_yaml(src_content)) return false
		if (!has_user_authored_content(dest_content)) return false
		warn_empty_site_writeback(options.site_name ?? 'site', relative_path)
		return true
	}
	return false
}

async function blocked_empty_schema_writebacks(temp_dir: string, site_dir: string, site_name: string, block_content_refs: Map<string, BlockContentReference[]>): Promise<Set<string>> {
	const blocked = new Set<string>()
	const blocks_dir = path.join(temp_dir, 'blocks')

	let block_names: string[]
	try {
		block_names = await fs.readdir(blocks_dir)
	} catch {
		return blocked
	}

	for (const block_name of block_names) {
		if (block_name.startsWith('.')) continue

		const relative_path = `blocks/${block_name}/fields.yaml`
		let src_content: string
		try {
			src_content = await fs.readFile(path.join(blocks_dir, block_name, 'fields.yaml'), 'utf-8')
		} catch {
			continue
		}

		if (!is_empty_fields_yaml(src_content)) continue

		let dest_content = ''
		try {
			dest_content = await fs.readFile(path.join(site_dir, relative_path), 'utf-8')
		} catch {
			// Missing local file: still block if page content references the block.
		}

		const refs = block_content_refs.get(block_name) ?? []
		const local_has_fields = has_user_authored_fields(dest_content)
		if (local_has_fields || refs.length > 0) {
			warn_empty_schema_writeback(site_name, relative_path, block_name, refs, local_has_fields)
		}
		if (refs.length > 0) {
			blocked.add(relative_path)
		}
	}

	return blocked
}

// A CMS export is only a safe mirror target while it still describes a
// bootable site. An export that dropped pages/index.yaml is a partial read of
// the CMS — mid-import, partially seeded, or never imported — not a real
// "the user deleted every page" state, because a site in that state can't
// start. Mirroring one onto disk prunes the whole workspace, so the caller
// skips the cycle instead.
//
// The local side is measured by whatever the sync actually manages, not by
// the homepage alone: a site can be mid-build with blocks and site data but
// no pages/index.yaml yet, and that content is just as prunable. Returns
// false only when there is genuinely nothing left to lose, so an empty site
// can still receive its first pull instead of wedging.
async function is_implausibly_thin_export(temp_dir: string, site_dir: string): Promise<boolean> {
	// The homepage has to be a regular file: a directory or symlink at that
	// path is a malformed export, not a bootable site, and the prune loop
	// would remove blocks and page-types before ever reaching the malformed
	// pages entry.
	try {
		const homepage_stat = await fs.lstat(path.join(temp_dir, HOMEPAGE_FILE))
		if (homepage_stat.isFile()) return false
	} catch {
		// No homepage at all — fall through to the content check.
	}

	for (const dir of SITE_SYNC_DIRS) {
		if (await has_any_file(path.join(site_dir, dir))) return true
	}
	return false
}

// True when the tree holds at least one file. Dot-entries are ignored so a
// stray .DS_Store doesn't read as content.
async function has_any_file(target_path: string): Promise<boolean> {
	let entries: import('fs').Dirent[]
	try {
		entries = await fs.readdir(target_path, { withFileTypes: true })
	} catch {
		return false
	}

	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue
		if (entry.isDirectory()) {
			if (await has_any_file(path.join(target_path, entry.name))) return true
			continue
		}
		return true
	}
	return false
}

let warned_thin_library_export = false

function warn_thin_library_export(): void {
	if (warned_thin_library_export) return
	warned_thin_library_export = true

	console.log('')
	console.log(chalk.red('  ✗ library: refused CMS→file sync — the CMS returned no shared library'))
	console.log(chalk.red('    Local files were left alone. Mirroring this would have deleted the'))
	console.log(chalk.red('    whole library/ directory.'))
	console.log(chalk.dim('    The CMS library is likely not seeded yet. Restart `primo dev` without'))
	console.log(chalk.dim('    --author cms to push the local library up.'))
	console.log('')
}

function warn_thin_export(site_name: string, site_key: string): void {
	if (warned_thin_exports.has(site_key)) return
	warned_thin_exports.add(site_key)

	console.log('')
	console.log(chalk.red(`  ✗ ${site_name}: refused CMS→file sync — the CMS export has no ${HOMEPAGE_FILE}`))
	console.log(chalk.red('    Local files were left alone. Mirroring this export would have deleted'))
	console.log(chalk.red("    this site's pages, blocks and page types on disk."))
	console.log(chalk.dim('    The CMS is likely mid-import or only partially seeded. Restart `primo dev`'))
	console.log(chalk.dim('    without --author cms to push the local files back up.'))
	console.log('')
}

function is_excluded_path(relative_path: string, excluded_paths: Set<string>): boolean {
	const normalized = to_posix_path(relative_path)

	for (const excluded of excluded_paths) {
		if (normalized === excluded || normalized.startsWith(`${excluded}/`)) {
			return true
		}
	}

	return false
}

async function add_directory_to_archive(
	archive: archiver.Archiver,
	full_dir: string,
	archive_dir: string,
	excluded_paths: Set<string>
) {
	let entries
	try {
		entries = await fs.readdir(full_dir, { withFileTypes: true })
	} catch {
		return
	}

	for (const entry of entries) {
		const full_path = path.join(full_dir, entry.name)
		const archive_path = archive_dir ? `${archive_dir}/${entry.name}` : entry.name

		if (is_excluded_path(archive_path, excluded_paths)) {
			continue
		}

		if (entry.isDirectory()) {
			await add_directory_to_archive(archive, full_path, archive_path, excluded_paths)
		} else if (entry.isFile()) {
			archive.file(full_path, { name: archive_path })
		}
	}
}

function describe_duplicate(category: IDCategory, id: string, occurrences: DuplicateOccurrence[]): string {
	const files = [...new Set(occurrences.map((occurrence) => occurrence.file))].sort()

	switch (category) {
		case 'pages':
			return `duplicate page _id "${id}" in ${files.join(' and ')}`
		case 'page_sections':
			return `duplicate section _id "${id}" in ${files.join(' and ')}`
		case 'blocks':
			return `duplicate block _id "${id}" in ${files.join(' and ')}`
		case 'page_types':
			return `duplicate page type _id "${id}" in ${files.join(' and ')}`
		case 'site_fields':
			return `duplicate site field _id "${id}" in ${files.join(' and ')}`
		case 'block_fields':
			return `duplicate block field _id "${id}" in ${files.join(' and ')}`
		case 'page_type_fields':
			return `duplicate page type field _id "${id}" in ${files.join(' and ')}`
	}
}

async function prepare_site_for_local_dev(site_dir: string): Promise<LocalDevPreparation> {
	const excluded_paths = new Set<string>()
	const warnings: string[] = []
	const duplicates = new Map<IDCategory, Map<string, DuplicateOccurrence[]>>()

	const track_occurrence = (category: IDCategory, id: string, owner: string, file: string) => {
		track_duplicate(duplicates, category, id, { owner, file })
	}

	const pages_dir = path.join(site_dir, 'pages')
	for (const relative_path of await find_page_files(pages_dir)) {
		const full_path = path.join(site_dir, relative_path)
		const raw = await read_file_or_vanish(full_path, relative_path)
		if (raw === null) continue
		const page = load_yaml(raw) as Record<string, unknown> | undefined
		if (!page || typeof page !== 'object' || Array.isArray(page)) continue

		const page_id = get_entity_id(page)
		const page_sections = get_sections_array(page.sections)

		if (page_id) {
			track_occurrence('pages', page_id, relative_path, relative_path)
		}
		for (const section of page_sections) {
			const section_id = get_entity_id(section)
			if (section_id) {
				track_occurrence('page_sections', section_id, relative_path, relative_path)
			}
		}
	}

	const blocks_dir = path.join(site_dir, 'blocks')
	try {
		const block_names = await fs.readdir(blocks_dir)
		for (const block_name of block_names) {
			if (block_name.startsWith('.')) continue

			// Block _id lives in config.yaml; fields (each with their own _id)
			// live in a sibling fields.yaml as a bare list.
			const owner = `blocks/${block_name}`
			const relative_config_path = `blocks/${block_name}/config.yaml`
			const config_path = path.join(site_dir, relative_config_path)
			try {
				const raw = await fs.readFile(config_path, 'utf-8')
				const config = load_yaml(raw) as Record<string, unknown> | undefined
				if (config && typeof config === 'object' && !Array.isArray(config)) {
					const block_id = get_entity_id(config)
					if (block_id) {
						track_occurrence('blocks', block_id, owner, relative_config_path)
					}
				}
			} catch {
				// No config.yaml — skip
			}

			const relative_fields_path = `blocks/${block_name}/fields.yaml`
			const fields_path = path.join(site_dir, relative_fields_path)
			try {
				const raw = await fs.readFile(fields_path, 'utf-8')
				const block_fields = get_fields_array(load_yaml(raw))
				collect_field_ids(block_fields, (field_id) => {
					track_occurrence('block_fields', field_id, owner, relative_fields_path)
				})
			} catch {
				// No fields.yaml — skip
			}
		}
	} catch {
		// No blocks dir
	}

	const page_types_dir = path.join(site_dir, 'page-types')
	try {
		const page_type_names = await fs.readdir(page_types_dir)
		for (const page_type_name of page_type_names) {
			if (page_type_name.startsWith('.')) continue

			// Page type _id lives in config.yaml; fields live in sibling
			// fields.yaml as a bare list.
			const owner = `page-types/${page_type_name}`
			const relative_config_path = `page-types/${page_type_name}/config.yaml`
			const config_path = path.join(site_dir, relative_config_path)
			try {
				const raw = await fs.readFile(config_path, 'utf-8')
				const config = load_yaml(raw) as Record<string, unknown> | undefined
				if (config && typeof config === 'object' && !Array.isArray(config)) {
					const page_type_id = typeof config._id === 'string' && config._id ? config._id : undefined
					if (page_type_id) {
						track_occurrence('page_types', page_type_id, owner, relative_config_path)
					}
				}
			} catch {
				// No config.yaml — skip
			}

			const relative_fields_path = `page-types/${page_type_name}/fields.yaml`
			const fields_path = path.join(site_dir, relative_fields_path)
			try {
				const raw = await fs.readFile(fields_path, 'utf-8')
				const page_type_fields = get_fields_array(load_yaml(raw))
				collect_field_ids(page_type_fields, (field_id) => {
					track_occurrence('page_type_fields', field_id, owner, relative_fields_path)
				})
			} catch {
				// No fields.yaml — skip
			}
		}
	} catch {
		// No page-types dir
	}

	const site_fields_path = path.join(site_dir, 'site', 'fields.yaml')
	try {
		const raw = await fs.readFile(site_fields_path, 'utf-8')
		const site_fields_data = load_yaml(raw)
		const site_fields = get_fields_array(site_fields_data)
		if (site_fields.length > 0) {
			collect_field_ids(site_fields, (field_id) => {
				track_occurrence('site_fields', field_id, 'site/fields.yaml', 'site/fields.yaml')
			})
		}
	} catch {
		// No site fields file
	}

	for (const [category, by_id] of duplicates) {
		for (const [id, occurrences] of by_id) {
			if (occurrences.length < 2) {
				continue
			}

			for (const occurrence of occurrences) {
				excluded_paths.add(occurrence.owner)
			}

			warnings.push(describe_duplicate(category, id, occurrences))
		}
	}

	return {
		excluded_paths,
		warnings
	}
}

export type ImportWarning = {
	kind: string
	file: string
	path: string
	field: string
	block: string
	message: string
}

// Warning kinds where page content was matched to no field and therefore
// dropped from the render model. Counted separately from other import
// warnings (unknown blocks, orphan uploads, duplicate ids) so the
// end-of-boot summary can report "N fields dropped" accurately.
const DROPPED_FIELD_KINDS = new Set(['orphaned_field', 'orphaned_page_field'])

// Number of dropped-field warnings in an import response. Safe on any input
// shape (returns 0 for non-arrays / missing warnings).
function count_dropped_fields(warnings: unknown): number {
	if (!Array.isArray(warnings)) return 0
	return (warnings as ImportWarning[]).filter(w => DROPPED_FIELD_KINDS.has(w.kind)).length
}

// Coerce a raw import-response `warnings` value into a clean ImportWarning[]
// for persistence in sync_status.json. Defensive against partial/unknown
// server shapes: drops non-object entries and fills missing string fields so
// the agent-facing file always has a predictable schema. Returns [] for
// non-arrays / missing warnings.
function normalize_warning_details(warnings: unknown): ImportWarning[] {
	if (!Array.isArray(warnings)) return []
	return warnings
		.filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
		.map(w => ({
			kind: typeof w.kind === 'string' ? w.kind : '',
			file: typeof w.file === 'string' ? w.file : '',
			path: typeof w.path === 'string' ? w.path : '',
			field: typeof w.field === 'string' ? w.field : '',
			block: typeof w.block === 'string' ? w.block : '',
			message: typeof w.message === 'string' ? w.message : ''
		}))
}

// Loudly surface non-fatal import problems (e.g. orphaned fields whose
// content would otherwise be silently dropped). Printed in yellow with the
// full details so agents and humans both see exactly what was lost and where.
function print_import_warnings(site_name: string, warnings: unknown): number {
	if (!Array.isArray(warnings) || warnings.length === 0) return 0
	const list = warnings as ImportWarning[]
	console.log('')
	console.log(chalk.yellow(`  ⚠ ${site_name}: ${list.length} import warning${list.length === 1 ? '' : 's'}`))
	for (const w of list) {
		const msg = w.message || `${w.kind} at ${w.path} in ${w.file}`
		console.log(chalk.yellow(`    • ${msg}`))
	}
	console.log('')
	return list.length
}

export async function import_site_files(site_dir: string, api_url: string, config: SiteConfig, port: number, server_config: ServerConfig, use_bootstrap = true, workspace_dir: string = path.dirname(path.dirname(site_dir))): Promise<ImportTimings | null> {
	const site_name = config.name || 'My Site'
	const site_id = config.site_id
	const site_group = resolve_site_group(config, server_config)

	const preparation = await prepare_site_for_local_dev(site_dir)
	if (preparation.warnings.length > 0) {
		// Duplicate _ids (the only warning source in prepare_site_for_local_dev)
		// would leave the server with stale/dangling state if we pushed anyway,
		// so fail loudly instead of silently excluding the conflicting files.
		for (const warning of preparation.warnings) {
			console.log(chalk.red(`  ✖ ${config.name}: ${warning}`))
		}
		console.log(chalk.dim('    Remove one of the conflicting files and save to retry.'))
		const message = preparation.warnings[0]
		await write_sync_status(site_dir, {
			ok: false,
			error: message,
			failed_at: new Date().toISOString()
		}, { port, url: api_url })
		try {
			// Best-effort — older servers don't have this endpoint.
			await fetch(`${api_url}/api/primo/dev/status`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'error', message }),
				signal: AbortSignal.timeout(2000)
			})
		} catch {}
		return null
	}

	// Create ZIP of site files
	const zip_started = Date.now()
	const zip_buffer = await create_site_zip(site_dir, preparation.excluded_paths)
	const zip_ms = Date.now() - zip_started

	// Dev sites route via *.localhost. The host is computed from name+port
	// here and passed only to bootstrap (which seeds new sites with this
	// routing host); site.yaml does not carry host at all, and the regular
	// import path never sets host — so dashboard-managed routing is safe.
	const host = local_dev_host(config.name || path.basename(site_dir), port)

	if (!use_bootstrap) {
		const import_form = new FormData()
		import_form.append('file', new Blob([zip_buffer]), 'site.zip')

		const request_started = Date.now()
		const import_response = await fetch_with_timeout(`${api_url}/api/primo/import/${site_id}`, {
			method: 'POST',
			body: import_form
		}, 300000)
		const request_ms = Date.now() - request_started

		if (!import_response.ok) {
			const import_error = await import_response.text()
			throw new Error(`Import failed (${import_response.status}): ${import_error}`)
		}

		// Write created IDs back to files
		let warning_count = 0
		let dropped_field_count = 0
		let warning_details: ImportWarning[] = []
		try {
			const result = await import_response.json() as { created_ids?: Record<string, Record<string, unknown>>, warnings?: ImportWarning[] }
			if (result.created_ids) {
				await write_created_ids(site_dir, result.created_ids, server_config, workspace_dir)
			}
			warning_count = print_import_warnings(config.name, result.warnings)
			dropped_field_count = count_dropped_fields(result.warnings)
			warning_details = normalize_warning_details(result.warnings)
		} catch {
			// ignore JSON parse errors
		}

		return {
			zip_ms,
			request_ms,
			mode: 'import',
			ok: true,
			warning_count,
			dropped_field_count,
			warning_details
		}
	}

	// Retry bootstrap up to 3 times (collections may not be ready immediately)
	const max_retries = 3
	for (let attempt = 1; attempt <= max_retries; attempt++) {
		const form_data = new FormData()
		form_data.append('site_id', site_id)
		form_data.append('name', site_name)
		form_data.append('host', host)
		form_data.append('group', site_group.id)
		form_data.append('group_name', site_group.name)
		form_data.append('group_index', String(site_group.index ?? 0))
		form_data.append('server_groups', JSON.stringify(server_config.site_groups ?? [site_group]))
		form_data.append('file', new Blob([zip_buffer]), 'site.zip')

		try {
			const bootstrap_started = Date.now()
			const bootstrap_response = await fetch_with_timeout(`${api_url}/api/primo/bootstrap`, {
				method: 'POST',
				body: form_data
			}, 300000) // 300s timeout for imports
			const bootstrap_ms = Date.now() - bootstrap_started

			let warning_count = 0
			let dropped_field_count = 0
			let warning_details: ImportWarning[] = []
			if (bootstrap_response.ok) {
				try {
					const result = await bootstrap_response.json() as { created_ids?: Record<string, Record<string, unknown>>, warnings?: ImportWarning[], group_id?: string }
					// Bootstrap runs the same import as the regular path, so it
					// must write back created ids too — otherwise the very first
					// push never renames upload files to their canonical suffixed
					// names or rewrites symbolic refs, and later pushes keep
					// re-sending the un-suffixed names (the upload dup bug).
					if (result.created_ids) {
						await write_created_ids(site_dir, result.created_ids, server_config, workspace_dir)
					}
					warning_count = print_import_warnings(config.name, result.warnings)
					dropped_field_count = count_dropped_fields(result.warnings)
					warning_details = normalize_warning_details(result.warnings)
					await apply_server_group_id(result.group_id ?? '', site_dir, config, server_config, workspace_dir)
				} catch {
					// ignore JSON parse errors
				}
				return {
					zip_ms,
					request_ms: bootstrap_ms,
					mode: 'bootstrap',
					ok: true,
					warning_count,
					dropped_field_count,
					warning_details
				}
			}

			const error_text = await bootstrap_response.text()

			// Check if it's a collection not found error (timing issue)
			if (error_text.includes('collection') && attempt < max_retries) {
				await new Promise(resolve => setTimeout(resolve, 500 * attempt))
				continue
			}

			console.log(chalk.yellow(`  Bootstrap failed (${bootstrap_response.status}): ${error_text}`))

			// Bootstrap failed, try regular import
			const import_form = new FormData()
			import_form.append('file', new Blob([zip_buffer]), 'site.zip')

			const import_started = Date.now()
			const import_response = await fetch_with_timeout(`${api_url}/api/primo/import/${site_id}`, {
				method: 'POST',
				body: import_form
			}, 300000) // 300s timeout for imports
			const import_ms = Date.now() - import_started

			if (!import_response.ok) {
				const import_error = await import_response.text()
				console.log(chalk.yellow(`  Import failed (${import_response.status}): ${import_error}`))
			} else {
				// Write created IDs back to files
				try {
					const result = await import_response.json() as { created_ids?: Record<string, Record<string, unknown>>, warnings?: ImportWarning[] }
					if (result.created_ids) {
						await write_created_ids(site_dir, result.created_ids, server_config, workspace_dir)
					}
					warning_count = print_import_warnings(config.name, result.warnings)
					dropped_field_count = count_dropped_fields(result.warnings)
					warning_details = normalize_warning_details(result.warnings)
				} catch {
					// ignore JSON parse errors
				}
			}
			return {
				zip_ms,
				request_ms: bootstrap_ms + import_ms,
				mode: 'bootstrap+import',
				// Bootstrap failed and we fell back to a regular import; ok
				// reflects whether that fallback actually landed. When both
				// failed we still return timings (only logged above), so this
				// guards against recording a phantom success.
				ok: import_response.ok,
				warning_count,
				dropped_field_count,
				warning_details
			}
		} catch (err) {
			if (attempt < max_retries) {
				await new Promise(resolve => setTimeout(resolve, 500 * attempt))
				continue
			}
			if (err instanceof Error && err.name === 'AbortError') {
				throw new Error(`Timed out importing ${config.name}. If the local .primo data is stale, delete .primo and rerun primo dev.`)
			}
			throw err instanceof Error ? err : new Error(String(err))
		}
	}

	throw new Error(`Import failed for ${config.name}`)
}

async function import_library_files(base_dir: string, api_url: string, delete_group_ids: string[] = [], delete_symbol_ids: string[] = []): Promise<Pick<ImportTimings, 'zip_ms' | 'request_ms'>> {
	const library_dir = path.join(base_dir, LIBRARY_DIR)

	try {
		const stat = await fs.stat(library_dir)
		if (!stat.isDirectory()) return { zip_ms: 0, request_ms: 0 }
	} catch {
		return { zip_ms: 0, request_ms: 0 }
	}

	const has_deletes = delete_group_ids.length > 0 || delete_symbol_ids.length > 0

	// If the library is empty AND there are no explicit deletes, skip the
	// push entirely. This preserves the old behavior of not wiping the CMS
	// on accidental-empty-dir. Deletes are allowed through even on an empty
	// tree so a user can intentionally clear the library.
	if (!await has_library_content(library_dir) && !has_deletes) {
		return { zip_ms: 0, request_ms: 0 }
	}

	const zip_started = Date.now()
	const zip_buffer = await create_library_zip(base_dir)
	const zip_ms = Date.now() - zip_started
	const form_data = new FormData()
	form_data.append('file', new Blob([zip_buffer]), 'library.zip')
	if (has_deletes) {
		form_data.append('deletes', JSON.stringify({
			group_ids: delete_group_ids,
			symbol_ids: delete_symbol_ids
		}))
	}

	const request_started = Date.now()
	const response = await fetch_with_timeout(`${api_url}/api/primo/import-library`, {
		method: 'POST',
		body: form_data
	}, 120000)
	const request_ms = Date.now() - request_started

	if (response.status === 404) {
		throw new Error('Shared library sync is not supported by the current primo binary/server. Rebuild or update primo to use library sync.')
	}

	if (!response.ok) {
		const error_text = await response.text()
		throw new Error(error_text)
	}

	return { zip_ms, request_ms }
}

// Returns a map of posix-style relative paths (under library_path) to the
// underlying record ID for every group folder and block folder currently on
// disk. Group IDs come from library/groups.yaml, block IDs from the block's
// config.yaml. Missing IDs are null (new blocks that have never been pushed).
async function scan_library_folders(library_path: string): Promise<LibrarySnapshot> {
	const result: LibrarySnapshot = new Map()

	// Load group ID mapping from groups.yaml
	const group_ids: Record<string, string> = {}
	try {
		const raw = await fs.readFile(path.join(library_path, 'groups.yaml'), 'utf-8')
		const parsed = load_yaml(raw)
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				if (entry && typeof entry === 'object' && entry.folder && entry.id) {
					group_ids[String(entry.folder)] = String(entry.id)
				}
			}
		}
	} catch {
		// no groups.yaml, leave group_ids empty
	}

	let groups: import('fs').Dirent[]
	try {
		groups = await fs.readdir(library_path, { withFileTypes: true })
	} catch {
		return result
	}
	for (const group of groups) {
		if (!group.isDirectory() || group.name.startsWith('.')) continue
		const group_rel = group.name
		result.set(group_rel, { kind: 'group', id: group_ids[group_rel] ?? null })
		const group_dir = path.join(library_path, group.name)
		let blocks: import('fs').Dirent[]
		try {
			blocks = await fs.readdir(group_dir, { withFileTypes: true })
		} catch {
			continue
		}
		for (const block of blocks) {
			if (!block.isDirectory() || block.name.startsWith('.')) continue
			const block_dir = path.join(group_dir, block.name)
			let has_block_file = false
			let block_id: string | null = null
			try {
				const files = await fs.readdir(block_dir)
				has_block_file = files.some(f => f === 'component.svelte' || f === 'config.yaml' || f === 'fields.yaml' || f === 'content.yaml')
				if (files.includes('config.yaml')) {
					try {
						const raw = await fs.readFile(path.join(block_dir, 'config.yaml'), 'utf-8')
						const parsed = load_yaml(raw)
						if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
							const rec = parsed as Record<string, unknown>
							if (typeof rec._id === 'string' && rec._id) block_id = rec._id
							else if (typeof rec.id === 'string' && rec.id) block_id = rec.id as string
						}
					} catch {
						// ignore
					}
				}
			} catch {
				// ignore
			}
			if (has_block_file) {
				result.set(`${group_rel}/${block.name}`, { kind: 'block', id: block_id })
			}
		}
	}
	return result
}

async function create_library_zip(base_dir: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const archive = archiver('zip', { zlib: { level: LOCAL_ZIP_COMPRESSION_LEVEL } })
		const chunks: Buffer[] = []

		archive.on('data', chunk => chunks.push(chunk))
		archive.on('end', () => resolve(Buffer.concat(chunks)))
		archive.on('error', reject)

		archive.directory(path.join(base_dir, LIBRARY_DIR), LIBRARY_DIR)
		archive.finalize()
	})
}

async function create_site_zip(dir: string, excluded_paths: Set<string> = new Set()): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const archive = archiver('zip', { zlib: { level: LOCAL_ZIP_COMPRESSION_LEVEL } })
		const chunks: Buffer[] = []

		archive.on('data', chunk => chunks.push(chunk))
		archive.on('end', () => resolve(Buffer.concat(chunks)))
		archive.on('error', reject)

		void (async () => {
			try {
				const dirs_to_include = ['blocks', 'page-types', 'pages', 'site', 'uploads']
				for (const subdir of dirs_to_include) {
					const full_path = path.join(dir, subdir)
					await add_directory_to_archive(archive, full_path, subdir, excluded_paths)
				}

				const site_json = path.join(dir, SITE_CONFIG_FILE)
				if (!is_excluded_path(SITE_CONFIG_FILE, excluded_paths)) {
					archive.file(site_json, { name: SITE_CONFIG_FILE })
				}

				await archive.finalize()
			} catch (error) {
				reject(error)
			}
		})()
	})
}

async function sync_from_cms(site_dir: string, api_url: string, config: SiteConfig, server_config: ServerConfig, workspace_dir: string, sync_policy: SyncPolicy = { mode: 'both' }): Promise<void> {
	const response = await fetch_with_timeout(`${api_url}/api/primo/export/${config.site_id}`, {}, 15000)
	if (!response.ok) return

	const zip_data = await response.arrayBuffer()

	// Extract to temp directory
	const temp_dir = path.join(site_dir, '.primo', 'sync-temp')
	const temp_zip = path.join(temp_dir, 'export.zip')

	await fs.rm(temp_dir, { recursive: true, force: true })
	await fs.mkdir(temp_dir, { recursive: true })
	await fs.writeFile(temp_zip, Buffer.from(zip_data))
	await extract(temp_zip, { dir: temp_dir })
	await fs.unlink(temp_zip)

	const site_key = get_site_sync_key(site_dir, config)
	if (await is_implausibly_thin_export(temp_dir, site_dir)) {
		warn_thin_export(config.name, site_key)
		await fs.rm(temp_dir, { recursive: true, force: true })
		return
	}
	warned_thin_exports.delete(site_key)

	const format_options = resolve_format_options(server_config)
	const block_content_refs = await collect_block_content_references(site_dir)
	const blocked_writebacks = await blocked_empty_schema_writebacks(temp_dir, site_dir, config.name, block_content_refs)
	if (blocked_writebacks.size > 0) {
		await fs.rm(temp_dir, { recursive: true, force: true })
		return
	}
	const remote_snapshot = await collect_site_snapshot(temp_dir, {
		workspace_dir,
		format_options,
		dest_root: site_dir
	})
	const local_snapshot = await collect_site_snapshot(site_dir)
	const conflict_paths = sync_policy.mode === 'both'
		? find_conflict_paths(get_site_sync_baseline({ dir: site_dir, config }), local_snapshot, remote_snapshot)
		: []
	// Default conflict policy: files win. The caller can override by
	// running with --author cms, in which case the policy flips and the
	// CMS export is allowed to overwrite the conflicted local files.
	const skip_paths = sync_policy.mode === 'cms' ? new Set<string>() : new Set(conflict_paths)
	const sync_options: SyncDirectoryOptions = {
		workspace_dir,
		format_options,
		block_content_refs,
		site_name: config.name,
		skip_paths
	}

	// Compare and sync files
	const changed_files: string[] = []

	for (const dir of SITE_SYNC_DIRS) {
		const temp_path = path.join(temp_dir, dir)
		const local_path = path.join(site_dir, dir)

		if (await path_exists(temp_path)) {
			const files = await sync_directory(temp_path, local_path, dir, sync_options)
			changed_files.push(...files)
		} else if (await path_exists(local_path)) {
			// The CMS export dropped this whole directory. This branch used to
			// rm the tree outright, which made the largest possible CMS→file
			// delete both the only unrecoverable one and the only one that
			// ignored files-win conflict resolution.
			const removed_all = await prune_dropped_path(local_path, dir, sync_options)
			changed_files.push(describe_pruned_path(dir, removed_all))
		}
	}

	// Clean up temp directory
	await fs.rm(temp_dir, { recursive: true, force: true })
	// Baseline reflects the on-disk state we just produced. For paths we
	// skipped (files-win conflict resolution), the local snapshot's value
	// is correct — using remote_snapshot would re-trigger the conflict on
	// the next cycle since the file still differs from the CMS state.
	const post_baseline: ContentSnapshot = new Map(remote_snapshot)
	for (const skipped of skip_paths) {
		const local_value = local_snapshot.get(skipped)
		if (local_value === undefined) {
			post_baseline.delete(skipped)
		} else {
			post_baseline.set(skipped, local_value)
		}
	}
	site_sync_baselines.set(site_key, post_baseline)

	if (conflict_paths.length > 0) {
		const conflict_signature = conflict_paths.join('|')
		if (last_logged_conflicts.get(site_key) !== conflict_signature) {
			last_logged_conflicts.set(site_key, conflict_signature)
			if (sync_policy.mode === 'cms') {
				log_sync_conflict(config.name, 'CMS', 'local and CMS contents differ; CMS values were applied (--author cms; local edits saved to .primo/trash/)', conflict_paths)
			} else {
				log_sync_conflict(config.name, 'files', 'local and CMS contents differ; local files were preserved (default policy: files win on conflict; pass --author cms to flip)', conflict_paths)
			}
		}
	} else {
		// Cleared up — clear the dedupe key so a fresh conflict re-prints.
		last_logged_conflicts.delete(site_key)
	}
	if (changed_files.length > 0) {
		for (const file of changed_files) {
			console.log(chalk.blue(`  ↓ ${config.name}: ${file}`))
		}
	}
}

async function sync_library_from_cms(base_dir: string, api_url: string): Promise<void> {
	const response = await fetch_with_timeout(`${api_url}/api/primo/export-library`, {}, 15000)
	if (response.status === 404) {
		throw new Error('Shared library sync is not supported by the current primo binary/server. Rebuild or update primo to use library sync.')
	}
	if (!response.ok) return

	const zip_data = await response.arrayBuffer()
	const temp_dir = path.join(base_dir, '.primo', 'library-sync-temp')
	const temp_zip = path.join(temp_dir, 'library.zip')

	await fs.rm(temp_dir, { recursive: true, force: true })
	await fs.mkdir(temp_dir, { recursive: true })
	await fs.writeFile(temp_zip, Buffer.from(zip_data))
	await extract(temp_zip, { dir: temp_dir })
	await fs.unlink(temp_zip)

	const temp_library_path = path.join(temp_dir, LIBRARY_DIR)
	const local_library_path = path.join(base_dir, LIBRARY_DIR)
	let changed_files: string[] = []
	if (await has_any_file(temp_library_path)) {
		// workspace_dir/site_name are what gate trashing inside sync_directory.
		// Without them every library overwrite and prune ran with no backup at
		// all, unlike the per-site path. The matchers for the empty-writeback
		// guards anchor on blocks/ and site/, so a library/ path can't trip
		// them — site_name here is only the trash label.
		changed_files = await sync_directory(temp_library_path, local_library_path, LIBRARY_DIR, {
			workspace_dir: base_dir,
			site_name: LIBRARY_DIR
		})
	} else if (await has_library_content(local_library_path)) {
		// The CMS returned no library (or an empty one) while the workspace
		// has content. That is a CMS that was never seeded (in --author cms
		// the startup path pulls instead of importing, so the first run hits
		// this), not a user who deleted every shared block. Mirroring it
		// wipes the whole library, so refuse and leave the files alone.
		warn_thin_library_export()
		await fs.rm(temp_dir, { recursive: true, force: true })
		return
	} else if (await path_exists(local_library_path)) {
		// Local library is empty, so there is nothing to lose — but still trash
		// whatever is there before removing it.
		const removed_all = await prune_dropped_path(local_library_path, LIBRARY_DIR, {
			workspace_dir: base_dir,
			site_name: LIBRARY_DIR
		})
		changed_files = [describe_pruned_path(LIBRARY_DIR, removed_all)]
	}
	warned_thin_library_export = false

	await fs.rm(temp_dir, { recursive: true, force: true })
	library_snapshot = await scan_library_folders(local_library_path)

	if (changed_files.length > 0) {
		for (const file of changed_files) {
			console.log(chalk.blue(`  ↓ library: ${file}`))
		}
	}
}

async function sync_directory(
	src: string,
	dest: string,
	relative_path: string = '',
	options: SyncDirectoryOptions = {}
): Promise<string[]> {
	const changed_files: string[] = []
	const entries = await fs.readdir(src, { withFileTypes: true })
	const source_names = new Set(entries.map(entry => entry.name))

	// The destination has to be inspected before anything is created inside
	// it: mkdir and the recursive sync both follow a directory symlink, which
	// would write CMS content into the link's target outside the site.
	let dest_stat
	try {
		dest_stat = await fs.lstat(dest)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			console.log(chalk.dim(`  kept ${relative_path}: not synced (could not inspect)`))
			return changed_files
		}
	}
	if (dest_stat?.isSymbolicLink()) {
		console.log(chalk.dim(`  kept ${relative_path}: symlink, not followed`))
		return changed_files
	}
	if (dest_stat && !dest_stat.isDirectory()) {
		// A file where the export expects a directory (a type switch or a
		// local shape conflict). mkdir would throw and abort the whole sync
		// cycle, so keep it for the user to resolve instead.
		console.log(chalk.dim(`  kept ${relative_path}: not a directory, not synced`))
		return changed_files
	}
	await fs.mkdir(dest, { recursive: true })

	for (const entry of entries) {
		const src_path = path.join(src, entry.name)
		const dest_path = path.join(dest, entry.name)
		const file_relative = relative_path ? `${relative_path}/${entry.name}` : entry.name

		if (entry.isDirectory()) {
			// Same inspection for a subdirectory the export contains: a
			// symlink here would have the recursion follow the link.
			let child_stat
			try {
				child_stat = await fs.lstat(dest_path)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					console.log(chalk.dim(`  kept ${file_relative}: not synced (could not inspect)`))
					continue
				}
			}
			if (child_stat?.isSymbolicLink()) {
				console.log(chalk.dim(`  kept ${file_relative}: symlink, not followed`))
				continue
			}
			if (child_stat && !child_stat.isDirectory()) {
				console.log(chalk.dim(`  kept ${file_relative}: not a directory, not synced`))
				continue
			}
			const nested = await sync_directory(src_path, dest_path, file_relative, options)
			changed_files.push(...nested)
		} else {
			// "Files win on conflict" default: caller marked this path as
			// conflicted, so leave the local file alone and discard the CMS
			// value silently. Logging happens once at the call site.
			if (options.skip_paths?.has(file_relative)) {
				continue
			}

			let src_content = await fs.readFile(src_path, 'utf-8')

			// Run server-emitted file through the workspace's formatter so
			// per-user style (tabs, line width, single quotes, etc.) survives
			// the round-trip. Without this, every CMS export wipes out the
			// user's formatting and the file watcher fires another reimport.
			if (options.format_options && options.workspace_dir && should_format(dest_path)) {
				src_content = await format_file_contents(dest_path, src_content, options.workspace_dir, options.format_options)
			}

			// A symlink at the destination would route the read and the write
			// through to its target — potentially outside the site, with no
			// backup under the workspace. Keep the link; it is the user's and
			// not something the CMS export can describe.
			let dest_lstat
			try {
				dest_lstat = await fs.lstat(dest_path)
			} catch {
				// No local file at this path yet
			}
			if (dest_lstat?.isSymbolicLink()) {
				console.log(chalk.dim(`  kept ${file_relative}: symlink, not followed`))
				continue
			}

			let dest_content = ''
			try {
				dest_content = await fs.readFile(dest_path, 'utf-8')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					// File doesn't exist locally
				} else {
					// Unreadable: neither the comparison nor a backup of the
					// prior content is possible, so leave the file alone this
					// cycle and retry once the cause is gone.
					console.log(chalk.dim(`  kept ${file_relative}: unreadable, not overwritten`))
					continue
				}
			}

			if (should_skip_empty_block_schema_writeback(file_relative, src_content, dest_content, options)) {
				continue
			}

			if (should_skip_empty_site_writeback(file_relative, src_content, dest_content, options)) {
				continue
			}

			// Normalize to handle trailing newline/whitespace differences
			if (src_content.trim() !== dest_content.trim()) {
				// Trash the prior content so the user can recover if this
				// overwrite was unwanted. Skipped when there was no prior file.
				// If a backup can't be taken, the overwrite is skipped too:
				// the incoming value still exists on the CMS side, so a later
				// cycle retries it — the local value has no copy anywhere else.
				if (dest_content && (!options.workspace_dir || !options.site_name)) {
					console.log(chalk.dim(`  kept ${file_relative}: not overwritten without a trash backup (no trash location)`))
					continue
				}
				if (dest_content) {
					try {
						await trash_existing_file(dest_content, options.workspace_dir!, options.site_name!, file_relative)
					} catch {
						console.log(chalk.dim(`  kept ${file_relative}: not overwritten without a trash backup (trash write failed)`))
						continue
					}
				}

				// Track this file's content hash BEFORE writing so the
				// chokidar event our own write produces can be matched
				// against `synced_files` and dropped, while a genuine user
				// edit (different content) still falls through and pushes.
				synced_files.set(dest_path, hash_content(src_content))
				await fs.writeFile(dest_path, src_content)

				// Surface shrinkage on the change line itself so a user
				// scanning the dev log notices when a YAML list silently
				// loses entries (the failure mode reported during the
				// column-accounting beta).
				const shrink_delta = compute_shrink_delta(dest_content, src_content)
				const annotated = shrink_delta !== null
					? `${file_relative} (${shrink_delta} lines, prior in .primo/trash/)`
					: file_relative
				changed_files.push(annotated)
			}
		}
	}

	const dest_entries = await fs.readdir(dest, { withFileTypes: true })
	for (const entry of dest_entries) {
		if (source_names.has(entry.name)) {
			continue
		}

		const dest_path = path.join(dest, entry.name)
		const file_relative = relative_path ? `${relative_path}/${entry.name}` : entry.name

		// "Files win on conflict": caller marked this path as conflicted,
		// so leave the local file in place even though the CMS export
		// dropped it.
		if (options.skip_paths?.has(file_relative)) {
			continue
		}

		// Trash the file/tree before removing so a CMS-side delete
		// (often triggered by an upstream parse error dropping references)
		// is recoverable from .primo/trash/. skip_paths is re-checked per
		// descendant: this entry may be a directory holding a conflicted file.
		const removed_all = await prune_dropped_path(dest_path, file_relative, options)
		changed_files.push(describe_pruned_path(file_relative, removed_all))
	}

	return changed_files
}

async function has_library_content(library_dir: string): Promise<boolean> {
	let entries: import('fs').Dirent[]
	try {
		entries = await fs.readdir(library_dir, { withFileTypes: true })
	} catch (err: any) {
		// Missing library/ is normal in workspaces that haven't been
		// initialized for library sync — treat as empty rather than crashing
		// the sync loop.
		if (err?.code === 'ENOENT') return false
		throw err
	}

	for (const entry of entries) {
		if (entry.name.startsWith('.')) {
			continue
		}
		return true
	}

	return false
}

async function write_created_ids(
	site_dir: string,
	created_ids: Record<string, Record<string, unknown>>,
	server_config: ServerConfig,
	workspace_dir: string
): Promise<void> {
	const format_options = resolve_format_options(server_config)

	// Upload writeback is special: rename local files and rewrite any yaml
	// that still references symbolic paths. Surfaced under a non-standard
	// `_uploads` key in created_ids["uploads/.manifest.json"] so the rest of
	// this loop's `_id`/`sections` logic doesn't get confused by it.
	const uploads_payload = created_ids['uploads/.manifest.json']
	if (uploads_payload && typeof uploads_payload._uploads === 'object' && uploads_payload._uploads !== null) {
		await write_upload_writeback(site_dir, uploads_payload._uploads as Record<string, unknown>, server_config, workspace_dir)
	}

	for (const [relative_path, id_data] of Object.entries(created_ids)) {
		if (!id_data._id && !Array.isArray(id_data.sections)) continue

		const file_path = path.join(site_dir, relative_path)
		try {
			const content = await fs.readFile(file_path, 'utf-8')
			const parsed = load_yaml(content)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue

			let data = parsed as Record<string, unknown>
			let changed = false

			if (id_data._id && !data._id && !data.id) {
				data = { _id: id_data._id, ...data }
				changed = true
			}

			if (Array.isArray(id_data.sections) && Array.isArray(data.sections)) {
				const section_ids = id_data.sections
				const sections = data.sections.map((section, index) => {
					if (!section || typeof section !== 'object' || Array.isArray(section)) return section
					const section_record = section as Record<string, unknown>
					const section_id = section_ids[index]
					if (!section_id || section_record._id || section_record.id) return section
					changed = true
					return { _id: section_id, ...section_record }
				})
				if (changed) {
					data = { ...data, sections }
				}
			}

			if (changed) {
				const raw = dump_yaml(data, { lineWidth: -1 })
				const formatted = await format_file_contents(file_path, raw, workspace_dir, format_options)
				await fs.writeFile(file_path, formatted, 'utf-8')
				mark_written_file(file_path, formatted)
			}
		} catch {
			// skip if file doesn't exist or can't be read
		}
	}
}

// write_upload_writeback reconciles the local uploads/ folder and yaml refs
// with what the server actually stored on the latest push.
//
// For each entry `symbolic -> {id, canonical}`:
//   - If canonical != symbolic, rename uploads/<symbolic> to uploads/<canonical>
//     on disk so subsequent pulls/pushes round-trip without churn.
//   - Rewrite any yaml file that still says `upload: "uploads/<symbolic>"` to
//     the record id, matching what the server stored. This converges the local
//     copy with the server's canonical content shape without needing a pull.
//
// The watcher is told about each rename and rewrite via mark_written_file /
// mark_deleted_path so it doesn't echo our own writes back as user edits.
async function write_upload_writeback(
	site_dir: string,
	uploads_map: Record<string, unknown>,
	server_config: ServerConfig,
	workspace_dir: string
): Promise<void> {
	// Build a symbolic -> record-id map for the yaml rewrite pass. Skip
	// malformed entries instead of failing the whole writeback so a partial
	// server response can still rename what it can.
	const symbolic_to_id = new Map<string, string>()
	const renames: Array<{ symbolic: string; canonical: string }> = []

	for (const [symbolic, raw_entry] of Object.entries(uploads_map)) {
		if (!raw_entry || typeof raw_entry !== 'object') continue
		const entry = raw_entry as Record<string, unknown>
		const id = typeof entry.id === 'string' ? entry.id : ''
		const canonical = typeof entry.canonical === 'string' ? entry.canonical : ''
		if (!id) continue
		symbolic_to_id.set(symbolic, id)
		if (canonical && canonical !== symbolic) {
			renames.push({ symbolic, canonical })
		}
	}

	// Rename the on-disk files. Best-effort: if the symbolic file is missing
	// (already renamed by a prior push, or removed by the user) we silently
	// move on — the yaml rewrite still keeps content consistent.
	const uploads_dir = path.join(site_dir, 'uploads')
	for (const { symbolic, canonical } of renames) {
		const from = path.join(uploads_dir, symbolic)
		const to = path.join(uploads_dir, canonical)
		try {
			await fs.rename(from, to)
			mark_deleted_path(from)
			mark_written_file(to, await fs.readFile(to))
		} catch {
			// missing source or permission issue — skip
		}
	}

	// Rewrite symbolic upload references across all yaml under the site dir.
	// Walking the tree is bounded by site size and only re-marshals files
	// that mention `uploads/` literally, so the cost is small even on large
	// sites. Restricting to known sync subdirs avoids touching artifacts in
	// dot-directories or build output.
	if (symbolic_to_id.size === 0) return
	const format_options = resolve_format_options(server_config)
	for (const subdir of SITE_SYNC_DIRS) {
		const root = path.join(site_dir, subdir)
		const files = await walk_yaml_files(root).catch(() => [] as string[])
		for (const file_path of files) {
			try {
				const content = await fs.readFile(file_path, 'utf-8')
				if (!content.includes('uploads/')) continue
				const parsed = load_yaml(content)
				if (!parsed || typeof parsed !== 'object') continue
				const { value: rewritten, changed } = rewrite_symbolic_upload_refs(parsed, symbolic_to_id)
				if (!changed) continue
				const raw = dump_yaml(rewritten, { lineWidth: -1 })
				const formatted = await format_file_contents(file_path, raw, workspace_dir, format_options)
				await fs.writeFile(file_path, formatted, 'utf-8')
				mark_written_file(file_path, formatted)
			} catch {
				// skip unreadable / unparseable file
			}
		}
	}
}

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
			if (entry.isDirectory()) {
				stack.push(full)
			} else if (entry.isFile() && entry.name.endsWith('.yaml')) {
				out.push(full)
			}
		}
	}
	return out
}

// rewrite_symbolic_upload_refs is the CLI mirror of the server's rewriteUploadRefs.
// Walking on the CLI side handles the case where the server's in-zip rewrite
// updated the imported content but the source files on disk still reference
// the symbolic path. Without this pass, the next push would resend the
// symbolic ref and force the server to re-resolve every time.
function rewrite_symbolic_upload_refs(value: unknown, map: Map<string, string>): { value: unknown; changed: boolean } {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>
		let changed = false
		const result: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(obj)) {
			if (k === 'upload' && typeof v === 'string' && v.startsWith('uploads/')) {
				const filename = v.substring('uploads/'.length)
				const id = map.get(filename)
				if (id) {
					result[k] = id
					changed = true
					continue
				}
			}
			const child = rewrite_symbolic_upload_refs(v, map)
			result[k] = child.value
			if (child.changed) changed = true
		}
		return { value: result, changed }
	}
	if (Array.isArray(value)) {
		let changed = false
		const result = value.map(item => {
			const child = rewrite_symbolic_upload_refs(item, map)
			if (child.changed) changed = true
			return child.value
		})
		return { value: result, changed }
	}
	return { value, changed: false }
}

