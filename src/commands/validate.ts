import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import { load as load_yaml } from 'js-yaml'
import { get_head_svelte_validation_error } from '../utils/head-svelte.js'

interface ValidationError {
	file: string
	line?: number
	field?: string
	message: string
	severity: 'error' | 'warning'
}

interface ValidateOptions {
	dir: string
	strict?: boolean
}

export const VALID_FIELD_TYPES = [
	'text',
	'rich-text',
	'markdown',
	'image',
	'link',
	'url',
	'icon',
	'number',
	'switch',
	'select',
	'repeater',
	'group',
	'page',
	'page-list',
	'page-field',
	'site-field',
	'slider',
	'date',
	'info'
]

const MAX_FIELDS_FILE_BYTES = 256 * 1024
const MAX_TOTAL_FIELDS = 5000

// Warn-only normalization - logs issues but doesn't modify files
export async function normalize_site(site_dir: string): Promise<void> {
	const warnings: string[] = []

	const pages_dir = path.join(site_dir, 'pages')
	const homepage_path = path.join(pages_dir, 'index.yaml')

	try {
		await fs.access(homepage_path)
	} catch {
		throw new Error(`Missing required homepage file: pages/index.yaml`)
	}

	// Note: Missing IDs are normal for new entities - they will be assigned during import.
	// We only log the warnings array if other checks added warnings.
	if (warnings.length > 0) {
		for (const warning of warnings) {
			console.log(chalk.yellow(`  ⚠ ${warning}`))
		}
	}
}

async function parse_fields_file(file_path: string): Promise<unknown> {
	const stat = await fs.stat(file_path)
	if (stat.size > MAX_FIELDS_FILE_BYTES) {
		throw new Error(`fields file is too large (${stat.size} bytes). This usually indicates corrupted duplicated schema data.`)
	}

	const content = await fs.readFile(file_path, 'utf-8')
	const parsed = load_yaml(content)
	const total_fields = count_fields_recursive(get_fields_array(parsed))
	if (total_fields > MAX_TOTAL_FIELDS) {
		throw new Error(`fields file defines too many fields (${total_fields}). This usually indicates corrupted duplicated schema data.`)
	}

	return parsed
}

function get_field_id(field: any): string | undefined {
	return field?._id || field?.id
}

/**
 * Parses YAML with the same loader `primo build` uses and returns a
 * human-readable error when it fails. Validation must reject any file the
 * build refuses to parse — otherwise `primo validate` passes a site that
 * `primo build` then crashes on.
 */
function yaml_syntax_error(content: string): string | null {
	try {
		load_yaml(content)
		return null
	} catch (err: any) {
		const reason = err?.reason || err?.message || String(err)
		const mark = err?.mark
		const where = mark && typeof mark.line === 'number'
			? ` (line ${mark.line + 1}, column ${(mark.column ?? 0) + 1})`
			: ''
		return `${reason}${where}`
	}
}

function get_fields_array(data: unknown): any[] {
	if (Array.isArray(data)) {
		return data
	}

	if (data && typeof data === 'object' && Array.isArray((data as { fields?: unknown[] }).fields)) {
		return (data as { fields: any[] }).fields
	}

	return []
}

function count_fields_recursive(fields: any[]): number {
	let count = 0

	for (const field of fields) {
		count += 1
		if (Array.isArray(field?.subfields)) {
			count += count_fields_recursive(field.subfields)
		}
	}

	return count
}

function is_plain_object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validate_field_config(field: any, field_name: string, file_path: string): ValidationError[] {
	const errors: ValidationError[] = []

	if (!Object.prototype.hasOwnProperty.call(field, 'config')) {
		return errors
	}

	const config = field.config
	if (config === null || config === undefined) {
		return errors
	}

	if (typeof config === 'string') {
		if (config.trim() === '') {
			errors.push({
				file: file_path,
				field: field_name,
				message: 'Deprecated empty string "config". Remove it or replace it with a config object.',
				severity: 'warning'
			})
			return errors
		}

		errors.push({
			file: file_path,
			field: field_name,
			message: '"config" must be an object, null, or omitted',
			severity: 'error'
		})
		return errors
	}

	if (!is_plain_object(config)) {
		errors.push({
			file: file_path,
			field: field_name,
			message: '"config" must be an object, null, or omitted',
			severity: 'error'
		})
	}

	return errors
}

function collect_field_names(fields: any[], names = new Set<string>()): Set<string> {
	for (const field of fields) {
		if (field?.name) {
			names.add(field.name)
		}
		if (Array.isArray(field?.subfields)) {
			collect_field_names(field.subfields, names)
		}
	}

	return names
}

function validate_field_recursive(
	field: any,
	field_path: string,
	file_path: string,
	field_ids: Set<string>,
	field_names: Set<string>
): ValidationError[] {
	const errors: ValidationError[] = []
	const field_id = get_field_id(field)
	const field_name = field.name || field_id || '(unnamed)'
	const display_name = field_path || field_name

	// IDs are optional - they're assigned by the system during import.
	// Only check for duplicates if IDs are present.
	if (field_id) {
		if (field_ids.has(field_id)) {
			errors.push({
				file: file_path,
				field: display_name,
				message: `Duplicate field ID: "${field_id}"`,
				severity: 'error'
			})
		}
		field_ids.add(field_id)
	}

	if (!field.name) {
		errors.push({
			file: file_path,
			field: display_name,
			message: 'Missing required "name" field',
			severity: 'error'
		})
	}

	if (!field.label && field.type !== 'info') {
		errors.push({
			file: file_path,
			field: display_name,
			message: 'Missing "label" field',
			severity: 'warning'
		})
	}

	if (!field.type) {
		errors.push({
			file: file_path,
			field: display_name,
			message: 'Missing required "type" field',
			severity: 'error'
		})
		return errors
	}

	if (!VALID_FIELD_TYPES.includes(field.type)) {
		errors.push({
			file: file_path,
			field: display_name,
			message: `Invalid field type: "${field.type}". Valid types: ${VALID_FIELD_TYPES.join(', ')}`,
			severity: 'error'
		})
	}

	errors.push(...validate_field_config(field, display_name, file_path))

	if (field.type === 'select') {
		errors.push(...validate_select_field(field, display_name, file_path))
	}

	// Nested fields go under `subfields:`. A repeater/group written with
	// `fields:` imports as having no children and all its content is dropped.
	if ((field.type === 'repeater' || field.type === 'group') && field.fields !== undefined && field.subfields === undefined) {
		errors.push({
			file: file_path,
			field: display_name,
			message: `Nested fields of a ${field.type} go under "subfields:", not "fields:" — as written, it has no subfields and its content would be dropped`,
			severity: 'error'
		})
	} else if ((field.type === 'repeater' || field.type === 'group') && (!Array.isArray(field.subfields) || field.subfields.length === 0)) {
		errors.push({
			file: file_path,
			field: display_name,
			message: `A ${field.type} needs at least one entry under "subfields:"`,
			severity: 'warning'
		})
	}

	if (field.parent && !field_names.has(field.parent)) {
		errors.push({
			file: file_path,
			field: display_name,
			message: `Parent field "${field.parent}" not found`,
			severity: 'error'
		})
	}

	if (Array.isArray(field.subfields)) {
		for (const subfield of field.subfields) {
			const subfield_name = subfield?.name || get_field_id(subfield) || '(unnamed subfield)'
			errors.push(...validate_field_recursive(subfield, `${display_name}.${subfield_name}`, file_path, field_ids, field_names))
		}
	}

	return errors
}


export async function validate_site(options: ValidateOptions) {
	const dir = path.resolve(options.dir)
	// From a workspace root (server.yaml + sites/), validate every site instead
	// of failing on the root's missing pages/index.yaml.
	const is_workspace = await fs.access(path.join(dir, 'server.yaml')).then(() => true, () => false)
		&& !(await fs.access(path.join(dir, 'site.yaml')).then(() => true, () => false))
	if (is_workspace) {
		const sites_root = path.join(dir, 'sites')
		const site_dirs = (await fs.readdir(sites_root, { withFileTypes: true }).catch(() => []))
			.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
			.map(entry => path.join(sites_root, entry.name))
			.sort()
		if (site_dirs.length === 0) {
			console.log(chalk.yellow('No sites under sites/ to validate.'))
			return
		}
		let failed = 0
		for (const site_dir of site_dirs) {
			if (!await validate_one_site(site_dir, `sites/${path.basename(site_dir)}`)) failed++
		}
		if (failed > 0) process.exit(1)
		return
	}
	if (!await validate_one_site(dir)) process.exit(1)
}

// Returns false when there are errors (warnings alone pass).
async function validate_one_site(site_dir: string, label?: string): Promise<boolean> {
	const errors: ValidationError[] = []
	const warnings: ValidationError[] = []

	console.log(chalk.bold(`\n🔍 Validating ${label ?? 'site structure'}...\n`))

	try {
		// Check if directory exists
		await fs.access(site_dir)
	} catch {
		console.log(chalk.red(`✖ Directory not found: ${site_dir}`))
		process.exit(1)
	}

	// Check for issues (warn-only, no modifications)
	await normalize_site(site_dir)

	// Validate blocks
	const blocks_errors = await validate_blocks(site_dir)
	errors.push(...blocks_errors.filter(e => e.severity === 'error'))
	warnings.push(...blocks_errors.filter(e => e.severity === 'warning'))

	// Validate page types
	const page_types_errors = await validate_page_types(site_dir)
	errors.push(...page_types_errors.filter(e => e.severity === 'error'))
	warnings.push(...page_types_errors.filter(e => e.severity === 'warning'))

	// Validate site fields
	const site_errors = await validate_site_fields(site_dir)
	errors.push(...site_errors.filter(e => e.severity === 'error'))
	warnings.push(...site_errors.filter(e => e.severity === 'warning'))

	// Validate site head
	const site_head_errors = await validate_site_head(site_dir)
	errors.push(...site_head_errors.filter(e => e.severity === 'error'))
	warnings.push(...site_head_errors.filter(e => e.severity === 'warning'))

	// Validate site content (parsed by `primo build`)
	const site_content_errors = await validate_site_content(site_dir)
	errors.push(...site_content_errors.filter(e => e.severity === 'error'))
	warnings.push(...site_content_errors.filter(e => e.severity === 'warning'))

	// Validate pages
	const pages_errors = await validate_pages(site_dir)
	errors.push(...pages_errors.filter(e => e.severity === 'error'))
	warnings.push(...pages_errors.filter(e => e.severity === 'warning'))

	// Print results
	if (errors.length === 0 && warnings.length === 0) {
		console.log(chalk.green('✓ All validations passed!\n'))
		return true
	}

	if (warnings.length > 0) {
		console.log(chalk.yellow(`⚠ ${warnings.length} warning${warnings.length > 1 ? 's' : ''}:\n`))
		for (const warning of warnings) {
			print_error(warning)
		}
		console.log('')
	}

	if (errors.length > 0) {
		console.log(chalk.red(`✖ ${errors.length} error${errors.length > 1 ? 's' : ''}:\n`))
		for (const error of errors) {
			print_error(error)
		}
		console.log('')
		return false
	}
	return true
}

async function validate_blocks(site_dir: string): Promise<ValidationError[]> {
	const errors: ValidationError[] = []
	const blocks_dir = path.join(site_dir, 'blocks')

	try {
		await fs.access(blocks_dir)
	} catch {
		return [{
			file: 'blocks/',
			message: 'Blocks directory not found',
			severity: 'error'
		}]
	}

	const block_names = await fs.readdir(blocks_dir)

	for (const block_name of block_names) {
		if (block_name.startsWith('.')) continue

		const block_dir = path.join(blocks_dir, block_name)
		const stat = await fs.stat(block_dir)
		if (!stat.isDirectory()) continue

		// Check for required files - read actual directory listing to handle case-insensitive filesystems
		const block_files = await fs.readdir(block_dir)
		const fields_path = path.join(block_dir, 'fields.yaml')
		const config_path = path.join(block_dir, 'config.yaml')
		const content_path = path.join(block_dir, 'content.yaml')

		// Check for component.svelte with correct casing
		const component_file = block_files.find(f => f.toLowerCase() === 'component.svelte')
		if (!component_file) {
			errors.push({
				file: `blocks/${block_name}/`,
				message: 'Missing component.svelte file',
				severity: 'error'
			})
		} else if (component_file !== 'component.svelte') {
			errors.push({
				file: `blocks/${block_name}/${component_file}`,
				message: `Filename must be lowercase: "component.svelte", not "${component_file}". The import will silently skip this block.`,
				severity: 'error'
			})
		}

		// config.yaml is required (holds _id and display name).
		try {
			const raw = await fs.readFile(config_path, 'utf-8')
			const config = load_yaml(raw)
			if (!config || typeof config !== 'object' || Array.isArray(config)) {
				errors.push({
					file: `blocks/${block_name}/config.yaml`,
					message: 'Must be a YAML object with at least a `name` key.',
					severity: 'error'
				})
			} else if (!(config as any).name) {
				errors.push({
					file: `blocks/${block_name}/config.yaml`,
					message: 'Missing required "name" field.',
					severity: 'error'
				})
			}
		} catch {
			errors.push({
				file: `blocks/${block_name}/config.yaml`,
				message: 'Missing config.yaml or invalid YAML syntax. Each block needs a config.yaml with `_id` (system-stamped) and `name`.',
				severity: 'error'
			})
		}

		// fields.yaml is a bare top-level list of field definitions.
		try {
			const relative_fields_path = `blocks/${block_name}/fields.yaml`
			const fields_json = await parse_fields_file(fields_path)
			if (!Array.isArray(fields_json)) {
				errors.push({
					file: relative_fields_path,
					message: 'Must be a bare list of field definitions (no `fields:` wrapper). Start the file with `- name: ...`.',
					severity: 'error'
				})
			} else {
				errors.push(...validate_fields(fields_json, relative_fields_path))
			}
		} catch {
			errors.push({
				file: `blocks/${block_name}/fields.yaml`,
				message: 'Missing fields.yaml file or invalid YAML syntax',
				severity: 'error'
			})
		}

		// content.yaml is required for blocks — it seeds the editor sidebar and
		// is parsed by `primo build`.
		try {
			const content_raw = await fs.readFile(content_path, 'utf-8')
			const yaml_error = yaml_syntax_error(content_raw)
			if (yaml_error) {
				errors.push({
					file: `blocks/${block_name}/content.yaml`,
					message: `Invalid YAML syntax: ${yaml_error}`,
					severity: 'error'
				})
			}
		} catch {
			errors.push({
				file: `blocks/${block_name}/content.yaml`,
				message: 'Missing content.yaml. Every block needs default values (use `{}` if there are no defaults yet).',
				severity: 'error'
			})
		}
	}

	return errors
}

async function validate_page_types(site_dir: string): Promise<ValidationError[]> {
	const errors: ValidationError[] = []
	const page_types_dir = path.join(site_dir, 'page-types')

	try {
		await fs.access(page_types_dir)
	} catch {
		return [{
			file: 'page-types/',
			message: 'Page types directory not found',
			severity: 'warning'
		}]
	}

	const page_type_names = await fs.readdir(page_types_dir)

	for (const page_type_name of page_type_names) {
		if (page_type_name.startsWith('.')) continue

		const page_type_dir = path.join(page_types_dir, page_type_name)
		const stat = await fs.stat(page_type_dir)
		if (!stat.isDirectory()) continue

		const config_path = path.join(page_type_dir, 'config.yaml')
		const fields_path = path.join(page_type_dir, 'fields.yaml')
		const layout_path = path.join(page_type_dir, 'layout.yaml')

		try {
			const config_data = await fs.readFile(config_path, 'utf-8')
			let config: any

			try {
				config = load_yaml(config_data)
			} catch {
				errors.push({
					file: `page-types/${page_type_name}/config.yaml`,
					message: 'Invalid YAML syntax',
					severity: 'error'
				})
				continue
			}

			// Validate config has required fields
			if (!config || typeof config !== 'object' || Array.isArray(config)) {
				errors.push({
					file: `page-types/${page_type_name}/config.yaml`,
					message: 'Must be a YAML object',
					severity: 'error'
				})
				continue
			}
			if (!config.name) {
				errors.push({
					file: `page-types/${page_type_name}/config.yaml`,
					message: 'Missing "name" field',
					severity: 'error'
				})
			}
			if ('fields' in config) {
				errors.push({
					file: `page-types/${page_type_name}/config.yaml`,
					message: 'Page-type fields no longer live in config.yaml — move them to a sibling fields.yaml as a bare list.',
					severity: 'error'
				})
			}

		} catch {
			errors.push({
				file: `page-types/${page_type_name}/`,
				message: 'Missing config.yaml file',
				severity: 'error'
			})
		}

		// fields.yaml is a sibling bare list (may be `[]`); absent is allowed.
		try {
			const relative_fields_path = `page-types/${page_type_name}/fields.yaml`
			const fields_json = await parse_fields_file(fields_path)
			if (!Array.isArray(fields_json)) {
				errors.push({
					file: relative_fields_path,
					message: 'Must be a bare list of field definitions (no `fields:` wrapper). Use `[]` if there are no fields.',
					severity: 'error'
				})
			} else if (fields_json.length > 0) {
				errors.push(...validate_fields(fields_json, relative_fields_path))
			}
		} catch (err: any) {
			if (err?.code !== 'ENOENT') {
				errors.push({
					file: `page-types/${page_type_name}/fields.yaml`,
					message: 'Invalid YAML syntax in fields.yaml',
					severity: 'error'
				})
			}
		}

		// layout.yaml is required — comment-only stub is fine, but the file
		// must exist so the page type's header/body/footer slots are
		// discoverable, and it is parsed by `primo build`.
		try {
			const layout_raw = await fs.readFile(layout_path, 'utf-8')
			const yaml_error = yaml_syntax_error(layout_raw)
			if (yaml_error) {
				errors.push({
					file: `page-types/${page_type_name}/layout.yaml`,
					message: `Invalid YAML syntax: ${yaml_error}`,
					severity: 'error'
				})
			}
		} catch {
			errors.push({
				file: `page-types/${page_type_name}/layout.yaml`,
				message: 'Missing layout.yaml. Each page type needs one (use the comment-only stub if there are no shared header/body/footer sections yet).',
				severity: 'error'
			})
		}
	}

	return errors
}

async function validate_site_fields(site_dir: string): Promise<ValidationError[]> {
	const errors: ValidationError[] = []
	const site_fields_path = path.join(site_dir, 'site', 'fields.yaml')

	try {
		const relative_path = 'site/fields.yaml'
		const fields_json = await parse_fields_file(site_fields_path)

		// site fields must be a plain array, not wrapped in an object
		if (!Array.isArray(fields_json)) {
			errors.push({
				file: relative_path,
				message: 'Must be a plain array (e.g., []) not wrapped in an object. The import will fail.',
				severity: 'error'
			})
			return errors
		}

		// Validate as bare array of fields
		if (fields_json.length > 0) {
			const field_errors = validate_fields(fields_json, relative_path)
			errors.push(...field_errors)
		}

	} catch {
		errors.push({
			file: 'site/fields.yaml',
			message: 'Missing fields.yaml file or invalid YAML syntax',
			severity: 'warning'
		})
	}

	return errors
}

async function validate_site_content(site_dir: string): Promise<ValidationError[]> {
	const content_path = path.join(site_dir, 'site', 'content.yaml')
	try {
		const content = await fs.readFile(content_path, 'utf-8')
		const yaml_error = yaml_syntax_error(content)
		if (yaml_error) {
			return [{
				file: 'site/content.yaml',
				message: `Invalid YAML syntax: ${yaml_error}`,
				severity: 'error'
			}]
		}
	} catch (error: any) {
		if (error?.code !== 'ENOENT') {
			return [{
				file: 'site/content.yaml',
				message: `Failed to read file: ${error}`,
				severity: 'error'
			}]
		}
	}

	return []
}

async function validate_head_svelte_file(
	site_dir: string,
	relative_path: string
): Promise<ValidationError[]> {
	const head_path = path.join(site_dir, relative_path)

	try {
		const head_content = await fs.readFile(head_path, 'utf-8')
		const message = get_head_svelte_validation_error(head_content, relative_path)
		if (message) {
			return [{
				file: relative_path,
				message,
				severity: 'error'
			}]
		}
	} catch (error: any) {
		if (error?.code === 'ENOENT') {
			return []
		}

		return [{
			file: relative_path,
			message: `Failed to read file: ${error}`,
			severity: 'error'
		}]
	}

	return []
}

async function validate_site_head(site_dir: string): Promise<ValidationError[]> {
	const errors: ValidationError[] = []
	errors.push(...await validate_head_svelte_file(site_dir, 'site/head.svelte'))

	// Per-page-type head fragments use the same rules as the site head.
	const page_types_dir = path.join(site_dir, 'page-types')
	let entries: string[] = []
	try {
		entries = await fs.readdir(page_types_dir)
	} catch (error: any) {
		if (error?.code !== 'ENOENT') throw error
	}
	for (const name of entries) {
		errors.push(...await validate_head_svelte_file(site_dir, `page-types/${name}/head.svelte`))
	}

	return errors
}

function validate_fields(fields_json: any, file_path: string): ValidationError[] {
	const errors: ValidationError[] = []

	// Accept a bare list (canonical fields.yaml shape) or an object with a
	// `fields:` array (page/site doc passing its already-parsed fields list).
	const fields_array = get_fields_array(fields_json)
	if (fields_array.length === 0 && !Array.isArray(fields_json) && !is_plain_object(fields_json)) {
		errors.push({
			file: file_path,
			message: 'Expected a list of field definitions',
			severity: 'error'
		})
		return errors
	}

	const field_ids = new Set<string>()
	const field_names = collect_field_names(fields_array)

	for (const field of fields_array) {
		errors.push(...validate_field_recursive(field, field.name || get_field_id(field) || '(unnamed)', file_path, field_ids, field_names))
	}

	return errors
}

function validate_select_field(field: any, field_name: string, file_path: string): ValidationError[] {
	const errors: ValidationError[] = []

	if (!is_plain_object(field.config) || !field.config.options) {
		errors.push({
			file: file_path,
			field: field_name,
			message: 'Select field missing "config.options" array',
			severity: 'error'
		})
		return errors
	}

	if (!Array.isArray(field.config.options)) {
		errors.push({
			file: file_path,
			field: field_name,
			message: 'Select field "config.options" must be an array',
			severity: 'error'
		})
		return errors
	}

	for (let i = 0; i < field.config.options.length; i++) {
		const option = field.config.options[i]

		if (!option.label) {
			errors.push({
				file: file_path,
				field: field_name,
				message: `Option ${i + 1} missing "label" property`,
				severity: 'error'
			})
		}

		if (!option.value) {
			errors.push({
				file: file_path,
				field: field_name,
				message: `Option ${i + 1} missing "value" property`,
				severity: 'error'
			})
		}

		if (!('icon' in option)) {
			errors.push({
				file: file_path,
				field: field_name,
				message: `Option ${i + 1} missing "icon" property (can be empty string)`,
				severity: 'error'
			})
		}
	}

	return errors
}

async function validate_pages(site_dir: string): Promise<ValidationError[]> {
	const errors: ValidationError[] = []
	const pages_dir = path.join(site_dir, 'pages')
	const homepage_path = path.join(pages_dir, 'index.yaml')

	try {
		await fs.access(pages_dir)
	} catch {
		return [{
			file: 'pages/',
			message: 'Pages directory not found',
			severity: 'warning'
		}]
	}

	try {
		await fs.access(homepage_path)
	} catch {
		errors.push({
			file: 'pages/index.yaml',
			message: 'Missing required homepage file. Primo requires pages/index.yaml for the site root.',
			severity: 'error'
		})
	}

	// Recursively find all YAML files in pages directory
	const yaml_files = await find_yaml_files(pages_dir, 'pages')

	for (const yaml_file of yaml_files) {
		const file_path = path.join(site_dir, yaml_file)

		try {
			const content = await fs.readFile(file_path, 'utf-8')

			// Same loader as `primo build`; a syntax error here is build-fatal.
			const yaml_error = yaml_syntax_error(content)
			if (yaml_error) {
				errors.push({
					file: yaml_file,
					message: `Invalid YAML syntax: ${yaml_error}`,
					severity: 'error'
				})
				continue
			}

			if (/^slug:/m.test(content)) {
				errors.push({
					file: yaml_file,
					message: 'Page slug is now derived from the file path. Remove the "slug:" field; it is ignored.',
					severity: 'warning'
				})
			}

			// Check for common mistakes
			if (content.includes('\nblocks:') || content.match(/^blocks:/m)) {
				errors.push({
					file: yaml_file,
					message: 'Page uses "blocks:" but should use "sections:" with nested "content" objects. The import will fail.',
					severity: 'error'
				})
			}

			// Check that sections have the correct structure
			if (content.includes('\nsections:') || content.match(/^sections:/m)) {
				// Basic check: sections should have "block:" and "content:" keys
				const lines = content.split('\n')
				let in_sections = false
				let found_block = false
				let found_content = false

				for (const line of lines) {
					if (line.match(/^sections:/)) {
						in_sections = true
					} else if (in_sections && line.match(/^\s+- block:/)) {
						found_block = true
					} else if (in_sections && line.match(/^\s+content:/)) {
						found_content = true
					} else if (in_sections && line.match(/^[a-z]/)) {
						// New top-level key, end of sections
						in_sections = false
					}
				}

				if (found_block && !found_content) {
					errors.push({
						file: yaml_file,
						message: 'Sections missing "content:" key. Each section should have "block:" and "content:" keys.',
						severity: 'warning'
					})
				}
			}

		} catch (err) {
			errors.push({
				file: yaml_file,
				message: `Failed to read file: ${err}`,
				severity: 'error'
			})
		}
	}

	return errors
}

async function find_yaml_files(dir: string, relative_path: string): Promise<string[]> {
	const files: string[] = []

	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })

		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue

			const full_path = path.join(dir, entry.name)
			const rel_path = path.join(relative_path, entry.name)

			if (entry.isDirectory()) {
				const nested = await find_yaml_files(full_path, rel_path)
				files.push(...nested)
			} else if (entry.name.endsWith('.yaml')) {
				files.push(rel_path)
			}
		}
	} catch {
		// Directory doesn't exist or not readable
	}

	return files
}

function print_error(error: ValidationError) {
	const icon = error.severity === 'error' ? chalk.red('✖') : chalk.yellow('⚠')
	const location = error.field
		? `${error.file} → ${chalk.bold(error.field)}`
		: error.file

	console.log(`  ${icon} ${chalk.dim(location)}`)
	console.log(`    ${error.message}`)
}
