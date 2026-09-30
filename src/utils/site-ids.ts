import fs from 'fs/promises'
import path from 'path'
import { CORE_SCHEMA, dump as dump_yaml, load as load_yaml } from 'js-yaml'
import { read_site_config } from './site-config.js'

// Folders under sites/ that claim the same site_id. A backup made with
// `cp -r sites/x sites/x.bak` keeps x's site_id, and pushing both makes the
// copy overwrite the original on the server (last write wins).
export async function find_duplicate_site_ids(site_dirs: string[]): Promise<Map<string, string[]>> {
	const by_id = new Map<string, string[]>()
	for (const dir of site_dirs) {
		try {
			const id = (await read_site_config(dir)).site_id
			if (typeof id !== 'string' || !id.trim()) continue
			by_id.set(id, [...(by_id.get(id) ?? []), dir])
		} catch { /* unreadable site.yaml is reported elsewhere */ }
	}
	for (const [id, dirs] of by_id) if (dirs.length < 2) by_id.delete(id)
	return by_id
}

export function describe_duplicate_site_ids(duplicates: Map<string, string[]>, root: string): string {
	const lines = [...duplicates].map(([id, dirs]) =>
		`  site_id ${id} is used by ${dirs.map(dir => path.relative(root, dir)).join(' and ')}`)
	return [
		'These folders are copies of the same site, so pushing them would overwrite each other:',
		...lines,
		'Keep backups outside sites/ (for example in _backups/), or remove site_id from a copy that should become a new site and run `primo add`.'
	].join('\n')
}

// Parsed with CORE_SCHEMA so unquoted dates stay the strings they were
// (the default schema would turn 2026-01-15 into a Date and write it back as a
// timestamp). Mappings only are walked as records.
function is_mapping(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

function collect_ids_from(value: unknown, file: string, out: Map<string, string>): void {
	if (Array.isArray(value)) { for (const item of value) collect_ids_from(item, file, out); return }
	if (!is_mapping(value)) return
	for (const [key, v] of Object.entries(value)) {
		if (key === '_id' && (typeof v === 'string' || typeof v === 'number')) {
			if (!out.has(String(v))) out.set(String(v), file)
		} else collect_ids_from(v, file, out)
	}
}

// `_id` values in a site folder's YAML (pages, sections, blocks, fields...),
// read from parsed documents so comments and flow mappings don't hide them.
async function collect_entity_ids(dir: string, out: Map<string, string>, root = dir): Promise<void> {
	let entries
	try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
	for (const entry of entries) {
		if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) await collect_entity_ids(full, out, root)
		else if (/\.ya?ml$/.test(entry.name)) {
			let parsed: unknown
			try { parsed = load_yaml(await fs.readFile(full, 'utf8'), { schema: CORE_SCHEMA }) } catch { continue }
			collect_ids_from(parsed, path.relative(root, full), out)
		}
	}
}

// Ids in `target` that already belong to another site folder: what you get by
// copying a site to start a new one. Record ids are global, so importing them
// fails with "id: Value must be unique".
export async function find_copied_entity_ids(target: string, others: string[]): Promise<Array<{ id: string; file: string; source: string }>> {
	const mine = new Map<string, string>()
	await collect_entity_ids(target, mine)
	const copied: Array<{ id: string; file: string; source: string }> = []
	for (const other of others) {
		const theirs = new Map<string, string>()
		await collect_entity_ids(other, theirs)
		for (const [id, file] of mine) if (theirs.has(id)) copied.push({ id, file, source: other })
	}
	return copied
}

function strip_ids(value: unknown): { value: unknown; removed: number } {
	if (Array.isArray(value)) {
		let removed = 0
		const out = value.map(item => { const r = strip_ids(item); removed += r.removed; return r.value })
		return { value: out, removed }
	}
	if (is_mapping(value)) {
		let removed = 0
		const out: Record<string, unknown> = {}
		for (const [key, v] of Object.entries(value)) {
			if (key === '_id') { removed++; continue }
			const r = strip_ids(v)
			removed += r.removed
			out[key] = r.value
		}
		return { value: out, removed }
	}
	return { value, removed: 0 }
}

// Remove every `_id` from a folder's YAML so it imports as a new site with
// fresh records (the dev server writes the new ids back). Works on parsed
// YAML: section ids are list items (`- _id: ...`), ids can carry comments or
// sit in flow mappings, and none of that survives line-based editing.
export async function strip_entity_ids(dir: string): Promise<number> {
	let removed = 0
	const walk = async (current: string): Promise<void> => {
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) { await walk(full); continue }
			if (!/\.ya?ml$/.test(entry.name)) continue
			let parsed: unknown
			try { parsed = load_yaml(await fs.readFile(full, 'utf8'), { schema: CORE_SCHEMA }) } catch { continue }
			const result = strip_ids(parsed)
			if (result.removed === 0) continue
			await fs.writeFile(full, dump_yaml(result.value, { lineWidth: -1, schema: CORE_SCHEMA }))
			removed += result.removed
		}
	}
	await walk(dir)
	return removed
}
