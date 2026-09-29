import fs from 'fs/promises'
import path from 'path'
import { dump as dump_yaml, load as load_yaml } from 'js-yaml'
import { DEFAULT_FORMAT_OPTIONS, type FormatOptions } from './format.js'

export interface SiteGroupConfig {
	id: string
	name: string
	index?: number
}

export interface ServerConfig {
	port?: number
	site_groups?: SiteGroupConfig[]
	format?: Partial<FormatOptions>
	// Default hosted server for `primo push` / `primo login` when no site.yaml
	// declares one. Written by `primo deploy` after a successful provision.
	server?: string
}

export const SERVER_CONFIG_FILE = 'server.yaml'

export function get_server_config_path(base_dir: string): string {
	return path.join(base_dir, SERVER_CONFIG_FILE)
}

// Normalize a user-supplied server value: prepend a protocol when missing and
// strip trailing slashes. Bare localhost/127.0.0.1 stay on http:// (local dev);
// everything else gets https://.
export function normalize_server_url(server: string): string {
	let normalized = server.trim()
	if (!/^https?:\/\//.test(normalized)) {
		const is_local = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?(\/|$)/.test(normalized)
		normalized = `${is_local ? 'http' : 'https'}://${normalized}`
	}
	return normalized.replace(/\/+$/, '')
}

export function format_group_name(group_id: string): string {
	if (!group_id.trim()) return 'Default'

	return group_id
		.replace(/[-_]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase())
}

/**
 * A notice explaining that Primo assigns site-group ids on import and matches
 * groups by name, so `server.yaml`'s `id` is only a local reference. Returns
 * null when there is nothing surprising to explain.
 *
 * Short, human-chosen ids are the ones that surprise people — the server
 * replaces them with an assigned id. Ids that already look server-assigned are
 * left alone so the notice stays quiet.
 */
export function group_id_notice(group_ref: string | undefined, configured: SiteGroupConfig[]): string | null {
	const ref = group_ref?.trim()
	if (!ref) return null

	const group = configured.find((candidate) => candidate.id === ref || candidate.name === ref)
	const id = group?.id ?? ref
	if (id.length >= 15) return null

	const label = group?.name ?? ref
	return `group "${label}": Primo assigns group ids on import and matches groups by name — the id "${id}" in server.yaml is a local reference only.`
}

export function normalize_server_config(config: ServerConfig): ServerConfig {
	const site_groups = Array.isArray(config.site_groups)
		? config.site_groups.reduce<SiteGroupConfig[]>((groups, group, index) => {
				if (!group || typeof group.id !== 'string' || !group.id.trim()) return groups

				groups.push({
					id: group.id,
					name: typeof group.name === 'string' && group.name.trim() ? group.name : format_group_name(group.id),
					index: Number.isInteger(group.index) ? group.index : index
				})

				return groups
			}, [])
		: undefined

	return {
		port: config.port,
		site_groups,
		format: config.format,
		server: typeof config.server === 'string' && config.server.trim()
			? config.server.trim().replace(/\/+$/, '')
			: undefined
	}
}

export function resolve_format_options(config: ServerConfig): FormatOptions {
	return { ...DEFAULT_FORMAT_OPTIONS, ...(config.format ?? {}) }
}

export async function read_server_config(base_dir: string): Promise<ServerConfig> {
	const config_data = await fs.readFile(get_server_config_path(base_dir), 'utf-8')
	return normalize_server_config(load_yaml(config_data) as ServerConfig)
}

export const DEFAULT_PORT = 3000

export async function write_server_config(base_dir: string, config: ServerConfig): Promise<void> {
	const normalized = normalize_server_config(config)
	await fs.writeFile(get_server_config_path(base_dir), dump_yaml(normalized, { lineWidth: -1, noRefs: true }))
}
