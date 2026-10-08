import fs from 'fs/promises'
import path from 'path'
import { createHash } from 'crypto'
import { load, dump } from 'js-yaml'

const CONTENT_DIRS = ['blocks', 'page-types', 'pages', 'site']
type UploadEntry = { id?: unknown; hash?: unknown; canonical?: unknown }
type WriteFile = (file: string, contents: string | Buffer) => Promise<void>
type DevUploadPath = { name: string; hash: string }
const write_file: WriteFile = async (file, contents) => { await fs.writeFile(file, contents) }

function safe_name(name: string): boolean {
	return !!name && !name.startsWith('.') && !/[\\/\0]/.test(name) && path.basename(name) === name
}

async function read_manifest(root: string): Promise<Record<string, UploadEntry>> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(root, 'uploads/.manifest.json'), 'utf8'))
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
		throw error
	}
}

async function local_uploads(site_dir: string): Promise<Map<string, string>> {
	const hashes = new Map<string, string>()
	const dir = path.join(site_dir, 'uploads')
	const stat = await fs.lstat(dir).catch(error => {
		if (error.code === 'ENOENT') return undefined
		throw error
	})
	if (!stat) return hashes
	if (!stat.isDirectory()) throw new Error(`Uploads must be a directory: ${dir}`)
	let entries
	try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return hashes
		throw error
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !safe_name(entry.name)) continue
		hashes.set(entry.name, createHash('sha256').update(await fs.readFile(path.join(dir, entry.name))).digest('hex'))
	}
	return hashes
}

function matching_name(name: string, entry: UploadEntry, hashes: Map<string, string>): string | undefined {
	if (safe_name(name) && hashes.has(name)) return name
	if (typeof entry.hash === 'string' && entry.hash) {
		return [...hashes].find(([, hash]) => hash === entry.hash)?.[0]
	}
	return undefined
}

function add_refs(refs: Map<string, string>, entries: Record<string, unknown>, hashes: Map<string, string>): void {
	const ambiguous = new Set<string>()
	for (const [name, raw] of Object.entries(entries)) {
		if (!safe_name(name) || !raw || typeof raw !== 'object') continue
		const entry = raw as UploadEntry
		if (typeof entry.id !== 'string' || !entry.id) continue
		const local_name = matching_name(name, entry, hashes)
		if (local_name) {
			const previous = refs.get(entry.id)?.slice('uploads/'.length)
			if (previous && hashes.get(previous) !== hashes.get(local_name)) ambiguous.add(entry.id)
			refs.set(entry.id, `uploads/${local_name}`)
		}
	}
	for (const id of ambiguous) refs.delete(id)
}

// Rewrite only upload keys. Ordinary text, external URLs and symbolic paths
// retain their meaning; database IDs belong in the database, not source files.
async function rewrite_ids(root: string, refs: Map<string, string>, write: WriteFile): Promise<void> {
	const walk = async (dir: string): Promise<void> => {
		const stat = await fs.lstat(dir).catch(error => {
			if (error.code === 'ENOENT') return undefined
			throw error
		})
		if (!stat?.isDirectory()) return
		let entries
		try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
			throw error
		}
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue
			const file = path.join(dir, entry.name)
			if (entry.isDirectory()) { await walk(file); continue }
			if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
			const raw = await fs.readFile(file, 'utf8')
			if (![...refs.keys()].some(id => raw.includes(id))) continue
			const value = load(raw)
			let changed = false
			const rewrite = (node: unknown): void => {
				if (!node || typeof node !== 'object') return
				for (const [key, child] of Object.entries(node)) {
					const ref = key === 'upload' && typeof child === 'string' ? refs.get(child) : undefined
					if (ref) { (node as Record<string, unknown>)[key] = ref; changed = true }
					else rewrite(child)
				}
			}
			rewrite(value)
			if (changed) await write(file, dump(value, { lineWidth: -1 }))
		}
	}
	for (const dir of CONTENT_DIRS) await walk(path.join(root, dir))
}

// Map each manifest upload ID to its symbolic `uploads/<file>` path on disk,
// so content that still references uploads by ID can be resolved locally.
export async function read_upload_paths(site_dir: string): Promise<Map<string, string>> {
	const refs = new Map<string, string>()
	add_refs(refs, await read_manifest(site_dir), await local_uploads(site_dir))
	return refs
}

// Imports must leave authored names and symbolic refs intact. Recover older
// bare IDs using the existing manifest or the response's filename/hash map.
export async function preserve_upload_paths(site_dir: string, entries: Record<string, unknown>, write: WriteFile = write_file): Promise<void> {
	const hashes = await local_uploads(site_dir)
	const refs = new Map<string, string>()
	add_refs(refs, await read_manifest(site_dir), hashes)
	add_refs(refs, entries, hashes)
	await rewrite_ids(site_dir, refs, write)
}

// Keep database-specific identity out of the site's portable upload manifest.
// This cache also stabilizes snapshots when a file is edited before reimport:
// an unchanged CMS image must still use its authored name despite new local bytes.
export async function remember_dev_upload_paths(site_dir: string, entries: Record<string, unknown>): Promise<void> {
	const hashes = await local_uploads(site_dir)
	const paths: Record<string, DevUploadPath> = {}
	for (const [name, raw] of Object.entries(entries)) {
		if (!safe_name(name) || !raw || typeof raw !== 'object') continue
		const entry = raw as UploadEntry
		if (typeof entry.id !== 'string' || !entry.id || typeof entry.hash !== 'string' || !entry.hash) continue
		const local_name = matching_name(name, entry, hashes)
		if (local_name) paths[entry.id] = { name: local_name, hash: entry.hash }
	}
	await fs.mkdir(path.join(site_dir, '.primo'), { recursive: true })
	await fs.writeFile(path.join(site_dir, '.primo/dev-upload-paths.json'), JSON.stringify(paths))
}

async function read_dev_upload_paths(site_dir: string): Promise<Record<string, DevUploadPath>> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(site_dir, '.primo/dev-upload-paths.json'), 'utf8'))
		return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
		throw error
	}
}

// Normalize a local CMS export before BOTH conflict snapshots and file sync.
// Reuse authored filenames by content hash; copy editor-added images on sync.
// The hosted manifest stays intact because local dev never renames its files.
export async function prepare_dev_upload_export(site_dir: string, export_dir: string, write?: WriteFile): Promise<void> {
	const hashes = await local_uploads(site_dir)
	const known_paths = await read_dev_upload_paths(site_dir)
	const by_hash = new Map<string, string>()
	for (const [name, hash] of hashes) if (!by_hash.has(hash)) by_hash.set(hash, name)
	const refs = new Map<string, string>()
	const synced_paths: Record<string, DevUploadPath> = {}
	for (const [name, entry] of Object.entries(await read_manifest(export_dir))) {
		if (!safe_name(name) || !entry || typeof entry.id !== 'string' || !entry.id) continue
		const bytes = await fs.readFile(path.join(export_dir, 'uploads', name))
		const hash = createHash('sha256').update(bytes).digest('hex')
		const known = known_paths[entry.id]
		let local_name = known && typeof known.name === 'string' && safe_name(known.name) && known.hash === hash && hashes.has(known.name)
			? known.name : by_hash.get(hash)
		if (!local_name) {
			local_name = name
			// Never overwrite a local edit or follow a destination symlink.
			let suffix = 0
			while (await fs.lstat(path.join(site_dir, 'uploads', local_name)).then(() => true, error => {
				if (error.code === 'ENOENT') return false
				throw error
			})) {
				local_name = `${path.parse(name).name}-dev-${++suffix}${path.extname(name)}`
			}
			if (write) {
				await fs.mkdir(path.join(site_dir, 'uploads'), { recursive: true })
				await write(path.join(site_dir, 'uploads', local_name), bytes)
			}
			by_hash.set(hash, local_name)
		}
		refs.set(entry.id, `uploads/${local_name}`)
		synced_paths[entry.id] = { name: local_name, hash }
	}
	await rewrite_ids(export_dir, refs, write_file)
	if (write) {
		await fs.mkdir(path.join(site_dir, '.primo'), { recursive: true })
		await fs.writeFile(path.join(site_dir, '.primo/dev-upload-paths.json'), JSON.stringify(synced_paths))
	}
}
