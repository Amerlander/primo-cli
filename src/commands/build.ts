import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import ora from 'ora'
import { load as load_yaml } from 'js-yaml'
import { compile } from 'svelte/compiler'
import * as esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { read_site_config, type SiteConfig, SITE_CONFIG_FILE } from '../utils/site-config.js'
import { validate_head_svelte_content } from '../utils/head-svelte.js'
import { read_upload_paths } from '../utils/portable-uploads.js'
import { markdown_to_html, rich_text_to_html } from '../utils/rich-text.js'

// CSS reset applied to all sites by default
const CSS_RESET = `*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
body { line-height: 1.5; -webkit-font-smoothing: antialiased; }
img, picture, video, canvas, svg { display: block; max-width: 100%; }
input, button, textarea, select { font: inherit; }
p, h1, h2, h3, h4, h5, h6 { overflow-wrap: break-word; }`

interface BuildOptions {
	dir: string
	output: string
}

interface PageSection {
	_id?: string
	block: string
	content?: Record<string, unknown>
}

interface Page {
	_id?: string
	id?: string
	name: string
	slug?: string
	page_type: string
	sections: PageSection[]
	fields?: Record<string, unknown>
}

interface Layout {
	header?: PageSection[]
	// body sections are page-type seed defaults — the editor copies them onto a
	// page at creation. The renderer sources body from each page's own sections
	// (see resolve_page_sections below), so body is intentionally NOT rendered
	// from the layout here. It is parsed only so layout.yaml validates.
	body?: PageSection[]
	footer?: PageSection[]
}

interface BlockField {
	id?: string
	_id?: string
	name: string
	type: string
	label?: string
	config?: {
		field?: string // Name of site field to reference (for site-field type)
		[key: string]: unknown
	} | null
	options?: {
		field?: string // Backwards compatibility - name of site field
		[key: string]: unknown
	} | null
	subfields?: BlockField[]
}

interface SiteField {
	id?: string
	_id?: string
	name: string
	type: string
	label?: string
}

interface SiteData extends FieldContext {
	fields: SiteField[]
	content: Record<string, unknown>
}

// A page as page/page-list fields see it. Pages are kept in the order push
// creates them (sorted file paths), which is the order the CMS lists them in.
interface SitePage {
	id?: string
	name: string
	page_path: string
	page_type: string
	fields: Record<string, unknown>
}

// What field values are resolved against.
interface FieldContext {
	// Upload ID -> symbolic `uploads/<file>` path, from uploads/.manifest.json
	uploads: Map<string, string>
	pages: SitePage[]
	// Page type folder -> its config _id and field definitions
	page_types: Map<string, { id?: string; fields: BlockField[] }>
	// Resolved fields per referenced page, shared by all page/page-list fields
	page_content: Map<string, Record<string, unknown> | undefined>
	// Resolved fields of the page being rendered, read by page-field fields
	current_page?: Record<string, unknown>
}

export async function build_site(options: BuildOptions) {
	const spinner = ora('Building site...').start()

	try {
		const site_dir = path.resolve(options.dir)
		const output_dir = path.resolve(options.output)
		const temp_dir = path.join(site_dir, '.primo', 'build-temp')

		// Read site config
		let config: SiteConfig

		try {
			config = await read_site_config(site_dir)
		} catch {
			spinner.fail(`No ${SITE_CONFIG_FILE} found. Run \`primo new\` first.`)
			process.exit(1)
		}

		// Clean and create directories
		await fs.rm(output_dir, { recursive: true, force: true })
		await fs.mkdir(output_dir, { recursive: true })
		await fs.rm(temp_dir, { recursive: true, force: true })
		await fs.mkdir(temp_dir, { recursive: true })

		// Read head.svelte for global head content
		let head_content = ''
		try {
			const head_path = path.join(site_dir, 'site', 'head.svelte')
			head_content = await fs.readFile(head_path, 'utf-8')
			validate_head_svelte_content(head_content, 'site/head.svelte')
		} catch (error: any) {
			if (error?.code !== 'ENOENT') {
				throw error
			}
			// No head.svelte, that's fine
		}

		// site/foot.html is verbatim HTML appended before </body> on every page —
		// no templating, matching server publish. page-types/*/foot.html is
		// intentionally not included (it isn't in server publish either).
		let foot_content = ''
		try {
			foot_content = await fs.readFile(path.join(site_dir, 'site', 'foot.html'), 'utf-8')
		} catch (error: any) {
			if (error?.code !== 'ENOENT') {
				throw error
			}
		}

		// Find all pages, in the order push creates them
		const pages_dir = path.join(site_dir, 'pages')
		const page_files = (await find_pages(pages_dir))
			.map((file) => ({ file, key: path.relative(pages_dir, file).replaceAll('\\', '/') }))
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
			.map(({ file }) => file)

		// Map each page's _id to its live URL so internal `page:` links resolve.
		// The URL is derived from the page's file location (same convention the
		// build uses to write output), not the slug, so a page-ref and a raw
		// url pointing at the same page produce identical hrefs.
		const page_url_map = await build_page_url_map(site_dir, page_files)

		spinner.text = `Building ${page_files.length} page${page_files.length !== 1 ? 's' : ''}...`

		// Compile all blocks once and cache them
		const block_cache = new Map<string, { js: string; css: string }>()

		// Per block: whether it ships a client bundle in _symbols/
		const client_cache = new Map<string, boolean>()

		// Cache layouts per page type
		const layout_cache = new Map<string, Layout>()

		// Cache per-page-type head fragments (mirrors site head behavior; empty
		// string = no head.svelte for that page type).
		const page_type_head_cache = new Map<string, string>()

		// Load site data (fields, content, pages and page types)
		const site_data = await load_site_data(site_dir, page_files)

		// Build each page
		const failed_pages: Array<{ name: string; error: string }> = []
		for (const page_file of page_files) {
			const page_content = await fs.readFile(page_file, 'utf-8')
			const page = load_yaml(page_content) as Page
			const page_path = get_page_path_from_file(site_dir, page_file)

			spinner.text = `Building ${page.name || page_path || 'home'}...`

			const result = await build_page({
				page,
				page_path,
				site_dir,
				temp_dir,
				output_dir,
				head_content,
				foot_content,
				site_name: config.name,
				block_cache,
				client_cache,
				layout_cache,
				page_type_head_cache,
				site_data,
				page_url_map
			})

			if (result.error) {
				failed_pages.push({ name: page.name || page_path || 'home', error: result.error })
				console.log(chalk.yellow(`  Warning: ${page.name}: ${result.error}`))
			}

			// Determine output path from the page file path.
			const out_path = page_path === ''
				? path.join(output_dir, 'index.html')
				: path.join(output_dir, page_path, 'index.html')

			await fs.mkdir(path.dirname(out_path), { recursive: true })
			await fs.writeFile(out_path, result.html)
		}

		// Copy uploads directory
		const uploads_src = path.join(site_dir, 'uploads')
		const uploads_dest = path.join(output_dir, 'uploads')
		try {
			await copy_dir(uploads_src, uploads_dest)
		} catch {
			// No uploads directory, that's fine
		}

		// Clean up temp directory
		await fs.rm(temp_dir, { recursive: true, force: true })

		// A page that fell back to the error page is not a successful build: the
		// output contains "Build Error" HTML. Fail loudly so CI and agents see it
		// instead of a green build that shipped broken pages.
		if (failed_pages.length > 0) {
			const plural = failed_pages.length === 1 ? '' : 's'
			spinner.fail(`Build finished with ${failed_pages.length} failed page${plural}`)
			console.log('')
			for (const failure of failed_pages) {
				console.log(chalk.red(`  ✖ ${failure.name}: ${failure.error}`))
			}
			console.log('')
			console.log(chalk.dim(`  Fallback error pages were written to ${options.output}, but the build is not clean.`))
			console.log('')
			process.exitCode = 1
			return
		}

		spinner.succeed(`Built ${page_files.length} page${page_files.length !== 1 ? 's' : ''} to ${chalk.cyan(output_dir)}`)

		console.log('')
		console.log(chalk.dim('  Preview locally:'))
		console.log(chalk.dim(`    npx serve ${options.output}`))
		console.log('')
		console.log(chalk.dim('  Deploy:'))
		console.log(chalk.dim(`    npx vercel deploy ${options.output} --prod`))
		console.log(chalk.dim(`    npx netlify deploy --prod --dir=${options.output}`))
		console.log(chalk.dim(`    npx wrangler pages deploy ${options.output}`))
		console.log('')

	} catch (error) {
		spinner.fail(`Build failed: ${error instanceof Error ? error.message : error}`)
		if (error instanceof Error && error.stack) {
			console.log(chalk.dim(error.stack))
		}
		process.exit(1)
	}
}

interface BuildPageOptions {
	page: Page
	page_path: string
	site_dir: string
	temp_dir: string
	output_dir: string
	head_content: string
	foot_content: string
	site_name: string
	block_cache: Map<string, { js: string; css: string }>
	client_cache: Map<string, boolean>
	layout_cache: Map<string, Layout>
	page_type_head_cache: Map<string, string>
	site_data: SiteData
	page_url_map: Map<string, string>
}

// Field keys exposed to head fragments as bare identifiers. Anything that
// can't be a `let` binding (or would collide with the page component's own
// props) is skipped — the field just isn't available in head scope.
const RESERVED_HEAD_KEYS = new Set([
	'arguments', 'eval', 'implements', 'interface', 'package', 'private', 'protected', 'public',
	'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
	'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
	'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return',
	'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var',
	'void', 'while', 'with', 'yield', 'await', 'head_props'
])

function head_identifier_keys(keys: Iterable<string>): string[] {
	return [...new Set(keys)].filter((key) =>
		/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) &&
		!RESERVED_HEAD_KEYS.has(key) &&
		!/^section_\d+_props$/.test(key) &&
		!/^Section_\d+/.test(key)
	)
}

// Lazily load and validate a page type's head.svelte. Cached value is the raw
// fragment (may include <style>); empty string means "no head file present".
async function load_page_type_head(
	site_dir: string,
	page_type: string,
	cache: Map<string, string>
): Promise<string> {
	const cached = cache.get(page_type)
	if (cached !== undefined) return cached
	const head_path = path.join(site_dir, 'page-types', page_type, 'head.svelte')
	let content = ''
	try {
		content = await fs.readFile(head_path, 'utf-8')
		validate_head_svelte_content(content, `page-types/${page_type}/head.svelte`)
	} catch (error: any) {
		if (error?.code !== 'ENOENT') throw error
		content = ''
	}
	cache.set(page_type, content)
	return content
}

async function build_page(options: BuildPageOptions): Promise<{ html: string; error?: string }> {
	const { page, page_path, site_dir, temp_dir, output_dir, head_content, foot_content, site_name, block_cache, client_cache, layout_cache, page_type_head_cache, site_data, page_url_map } = options

	try {
		const page_build_id = safe_temp_id(page._id || page.id || page_path || page.name || 'page')

		// Load layout for this page type
		const page_type = page.page_type || 'default'
		let layout = layout_cache.get(page_type)
		if (layout === undefined) {
			layout = await load_layout(site_dir, page_type)
			layout_cache.set(page_type, layout)
		}

		// Page-type head is concatenated after the site head, mirroring server
		// publish behavior (site.head + page_type.head).
		const page_type_head = await load_page_type_head(site_dir, page_type, page_type_head_cache)
		const combined_head_content = page_type_head ? `${head_content}\n${page_type_head}` : head_content

		// The page's own fields, which page-field fields in every section
		// (layout ones included) read, as on server publish
		const page_type_fields = await load_page_type_fields(site_dir, page_type)
		const page_fields = resolve_field_values(page_type_fields, page.fields || {}, site_data)
		const section_data: SiteData = { ...site_data, current_page: page_fields }

		// Combine header + page sections + footer
		const current_page_id = page._id || page.id
		const header_sections = await resolve_layout_sections(layout.header || [], site_dir, section_data, page_url_map, current_page_id)
		const footer_sections = await resolve_layout_sections(layout.footer || [], site_dir, section_data, page_url_map, current_page_id)
		const page_sections = await resolve_page_sections(page.sections || [], site_dir, section_data, page_url_map, current_page_id)
		const sections = [...header_sections, ...page_sections, ...footer_sections]
		const section_slots = get_section_slots([
			...header_sections.map((section) => ({ section, zone: 'header' as const })),
			...page_sections.map((section) => ({ section, zone: 'main' as const })),
			...footer_sections.map((section) => ({ section, zone: 'footer' as const }))
		])

		// Head fragments see site fields merged with the page's own fields (page
		// wins), each pre-declared as a bare identifier — same scope as server
		// publish. Every DEFINED field key is declared even when no value is set
		// (binding to undefined), so `{seo_title || fallback}` works on pages
		// that leave the field empty instead of throwing ReferenceError.
		const head_data: Record<string, unknown> = { ...site_data.content, ...page_fields }
		const head_keys = head_identifier_keys([
			...site_data.fields.map((field) => field.name),
			...page_type_fields.map((field) => field.name),
			...Object.keys(head_data)
		])

		// Compile each block and collect CSS
		const all_css: string[] = []

		for (const section of sections) {
			const block_name = section.block

			// Check cache first
			let compiled = block_cache.get(block_name)
			if (!compiled) {
				compiled = await compile_block(site_dir, block_name, temp_dir)
				block_cache.set(block_name, compiled)
			}

			if (compiled.css) {
				all_css.push(compiled.css)
			}
		}

		// Create a page component that renders all sections and the head. The
		// head rides through <svelte:head> so its Svelte syntax ({expression},
		// {@html}, {#if}) is actually evaluated — pasting the fragment into the
		// output verbatim leaked raw template syntax into deployed pages.
		const page_component = generate_page_component(section_slots, combined_head_content, head_keys)
		const page_component_path = path.join(temp_dir, `page_${page_build_id}.svelte`)
		await fs.writeFile(page_component_path, page_component)

		// Compile the page component
		const page_source = await fs.readFile(page_component_path, 'utf-8')
		const page_compiled = compile(page_source, {
			generate: 'server',
			filename: page_component_path,
			css: 'external'
		})

		if (page_compiled.warnings.length > 0) {
			for (const warning of page_compiled.warnings) {
				if (!warning.message.includes('unused')) {
					console.log(chalk.yellow(`  Svelte warning: ${warning.message}`))
				}
			}
		}

		// Write compiled JS and bundle with esbuild
		const compiled_path = path.join(temp_dir, `page_${page_build_id}.js`)
		await fs.writeFile(compiled_path, page_compiled.js.code)

		// Copy all block compiled JS files to temp for bundling
		for (const section of sections) {
			const block_js_path = path.join(temp_dir, `${section.block}.compiled.js`)
			const cached = block_cache.get(section.block)
			if (cached?.js) {
				await fs.writeFile(block_js_path, cached.js)
			}
		}

		// Bundle with esbuild - include svelte runtime
		const bundle_path = path.join(temp_dir, `bundle_${page_build_id}.mjs`)

		// Find where svelte is installed (could be in primo-cli's node_modules or globally)
		const svelte_base = await find_svelte_path()

		await esbuild.build({
			entryPoints: [compiled_path],
			bundle: true,
			format: 'esm',
			platform: 'node',
			outfile: bundle_path,
			logLevel: 'silent',
			plugins: [svelte_resolver(svelte_base)]
		})

		// Import and render
		const bundle_url = `file://${bundle_path}`
		const { default: PageComponent } = await import(bundle_url)

		// Import render from svelte/server
		const { render } = await import('svelte/server')

		// Build props for all sections + the head fragment's field data
		const props: Record<string, unknown> = {}
		sections.forEach((section, i) => {
			props[`section_${i}_props`] = section.content || {}
		})
		props.head_props = head_data

		const rendered = render(PageComponent, { props })

		// Interactive blocks get a client bundle and hydrate in place, as on
		// server publish. Blocks without a script ship no JavaScript.
		const hydration_script = await generate_hydration_script(section_slots, { site_dir, temp_dir, output_dir, client_cache, svelte_base })

		// No automatic <title> — server publish emits none, and an injected
		// title would suppress any title a page-type head renders (Svelte keeps
		// the first <title> it encounters). Warn so the omission is visible.
		if (!/<title[\s>]/i.test(rendered.head || '')) {
			console.log(chalk.yellow(`  Warning: ${page.name || page_path || 'home'}: no <title> — render one from a head fragment (see the head-and-seo doc)`))
		}

		// Head <style> tags flow through rendered.head as real global style
		// elements (matching server publish). Reset first so head styles can
		// override it; block CSS last, as component styles land during render.
		const block_css = all_css.filter(Boolean).join('\n')
		const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
${CSS_RESET}
	</style>
	${rendered.head || ''}
${block_css ? `	<style>\n${block_css}\n	</style>\n` : ''}</head>
<body id="page">
${rendered.body || ''}
${hydration_script}${foot_content}</body>
</html>`

		return { html }

	} catch (error) {
		const error_msg = error instanceof Error ? error.message : String(error)
		return {
			html: generate_error_page(site_name, page.name, error_msg, head_content),
			error: error_msg,
		}
	}
}

async function compile_block(site_dir: string, block_name: string, temp_dir: string): Promise<{ js: string; css: string }> {
	const component_path = path.join(site_dir, 'blocks', block_name, 'component.svelte')

	try {
		const source = await read_block_source(site_dir, block_name)

		// Compile with Svelte
		const compiled = compile(source, {
			generate: 'server',
			filename: component_path,
			css: 'external',
			name: block_name.replace(/-/g, '_')
		})

		// Extract CSS
		const css = compiled.css?.code || ''

		// Write compiled JS for importing
		const output_path = path.join(temp_dir, `${block_name}.compiled.js`)
		await fs.writeFile(output_path, compiled.js.code)

		return { js: compiled.js.code, css }
	} catch (error) {
		console.log(chalk.yellow(`  Warning: Could not compile block "${block_name}": ${error}`))
		return { js: '', css: '' }
	}
}

async function read_block_source(site_dir: string, block_name: string): Promise<string> {
	const component_path = path.join(site_dir, 'blocks', block_name, 'component.svelte')
	const fields = await load_block_fields(site_dir, block_name)
	return inject_field_props(await fs.readFile(component_path, 'utf-8'), fields.map((field) => field.name))
}

interface ClientBuildOptions {
	site_dir: string
	temp_dir: string
	output_dir: string
	client_cache: Map<string, boolean>
	svelte_base: string
}

// The module script server publish appends to the body: import each
// interactive block's bundle once and hydrate every section using it, with
// the same props the section was rendered with.
async function generate_hydration_script(slots: SectionSlot[], options: ClientBuildOptions): Promise<string> {
	const imports: string[] = []
	for (const block_name of new Set(slots.map(({ section }) => section.block))) {
		let has_js = options.client_cache.get(block_name)
		if (has_js === undefined) {
			has_js = await bundle_block_client(block_name, options)
			options.client_cache.set(block_name, has_js)
		}
		if (!has_js) continue
		const hydrations = slots
			.filter(({ section }) => section.block === block_name)
			.map(({ section, dom_id }) =>
				`hydrate(App, { target: document.querySelector('#section-${dom_id}'), props: ${script_json(section.content || {})} });`
			)
			.join('')
		imports.push(`import('/_symbols/${encodeURIComponent(block_name)}.js').then(({ default: App, hydrate }) => {${hydrations}}).catch(e => console.error(e));`)
	}
	return imports.length > 0 ? `<script type="module">${imports.join('')}</script>\n` : ''
}

// Compile a block for the browser and bundle it with the svelte runtime
// into _symbols/<block>.js, exporting the component and `hydrate` like the
// server's symbol modules. Returns false for blocks without a script, which
// server publish doesn't hydrate either.
async function bundle_block_client(block_name: string, options: ClientBuildOptions): Promise<boolean> {
	const component_path = path.join(options.site_dir, 'blocks', block_name, 'component.svelte')
	const script = (await fs.readFile(component_path, 'utf-8')).match(/<script[^>]*>([\s\S]*?)<\/script>/)
	if (!script?.[1].trim()) return false

	const compiled = compile(await read_block_source(options.site_dir, block_name), {
		generate: 'client',
		filename: component_path,
		css: 'external',
		name: block_name.replace(/-/g, '_')
	})
	await fs.writeFile(path.join(options.temp_dir, `${block_name}.client.js`), compiled.js.code)

	await esbuild.build({
		stdin: {
			contents: `export { default } from './${block_name}.client.js'\nexport { hydrate } from 'svelte'\n`,
			resolveDir: options.temp_dir,
			loader: 'js'
		},
		bundle: true,
		format: 'esm',
		platform: 'browser',
		minify: true,
		outfile: path.join(options.output_dir, '_symbols', `${block_name}.js`),
		logLevel: 'silent',
		plugins: [svelte_resolver(options.svelte_base)]
	})
	return true
}

// JSON for an inline <script>: `<` is escaped so content can't close the tag.
function script_json(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c')
}

// Blocks may use their fields as bare identifiers without declaring props.
// Server publish injects `let { <fields> } = $props()` into any block that
// doesn't call $props() itself; do the same so such blocks render here too.
function inject_field_props(source: string, field_names: unknown[]): string {
	if (source.includes('$props(')) return source
	const keys = head_identifier_keys(field_names.filter((name): name is string => typeof name === 'string'))
	if (keys.length === 0) return source
	const declaration = `let { ${keys.join(', ')} } = $props()`
	const instance_script = /<script(?![^>]*\bmodule\b)(?![^>]*\bcontext\s*=\s*["']module["'])[^>]*>/
	return instance_script.test(source)
		? source.replace(instance_script, (tag) => `${tag}\n${declaration}\n`)
		: `<script>\n${declaration}\n</script>\n${source}`
}

interface SectionSlot {
	section: PageSection
	zone: 'header' | 'main' | 'footer'
	// Page-unique wrapper id: the section's _id when it has one
	dom_id: string
}

// Give each section a page-unique wrapper id, like the section record ids
// server publish uses.
function get_section_slots(sections: Array<Omit<SectionSlot, 'dom_id'>>): SectionSlot[] {
	const used = new Set<string>()
	return sections.map((slot, i) => {
		let dom_id = safe_temp_id(slot.section._id || `${i}`)
		if (used.has(dom_id)) dom_id = `${dom_id}-${i}`
		used.add(dom_id)
		return { ...slot, dom_id }
	})
}

function generate_page_component(slots: SectionSlot[], head_content: string, head_keys: string[]): string {
	const imports = slots.map(({ section }, i) => {
		return `import Section_${i} from './${section.block}.compiled.js'`
	}).join('\n')

	const props_declarations = [
		...slots.map((_, i) => `section_${i}_props = {}`),
		'head_props = {}'
	].join(',\n\t')

	// Bare identifiers for head scope; keys are pre-filtered to valid, safe
	// binding names by head_identifier_keys.
	// `$derived` (not a plain `let`) keeps these reactive and silences Svelte's
	// state_referenced_locally warning, which otherwise fires for every key.
	const head_declarations = head_keys.map((key) => `let ${key} = $derived(head_props['${key}'])`).join('\n')

	// Same page structure as server publish: header/main/footer zones (main
	// always, the others only when used), each section in a wrapper div.
	const render_zone = (zone: SectionSlot['zone']) => slots
		.map((slot, i) => ({ ...slot, i }))
		.filter((slot) => slot.zone === zone)
		.map(({ section, dom_id, i }) =>
			`<div data-section="${dom_id}" id="section-${dom_id}" data-symbol="${safe_temp_id(section.block)}"><Section_${i} {...section_${i}_props} /></div>`
		)
		.join('\n\t')
	const zones = (['header', 'main', 'footer'] as const)
		.map((zone) => ({ zone, markup: render_zone(zone) }))
		.filter(({ zone, markup }) => zone === 'main' || markup)
		.map(({ zone, markup }) => `<${zone}>\n\t${markup}\n</${zone}>`)
		.join('\n')

	return `<script module>
${imports}
</script>

<script>
let {
	${props_declarations}
} = $props()
${head_declarations}
</script>

<svelte:head>
${head_content}
</svelte:head>

${zones}`
}

function generate_error_page(site_name: string, page_name: string, error: string, head_content: string): string {
	const title = page_name === 'Home' ? site_name : `${page_name} | ${site_name}`

	// Extract just the CSS from head_content
	let head_css = ''
	const style_match = head_content.match(/<style[^>]*>([\s\S]*?)<\/style>/i)
	if (style_match) {
		head_css = style_match[1]
	}

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${escape_html(title)}</title>
	<style>
${CSS_RESET}
${head_css}
	</style>
</head>
<body>
	<div style="padding: 2rem; text-align: center;">
		<h1>Build Error</h1>
		<p style="color: #888;">${escape_html(error)}</p>
	</div>
</body>
</html>`
}

async function find_pages(pages_dir: string): Promise<string[]> {
	const pages: string[] = []

	async function scan(dir: string) {
		let entries
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			return
		}

		for (const entry of entries) {
			const full_path = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				await scan(full_path)
			} else if (entry.name.endsWith('.yaml')) {
				pages.push(full_path)
			}
		}
	}

	await scan(pages_dir)
	return pages
}

function get_page_path_from_file(site_dir: string, page_file: string): string {
	const pages_dir = path.join(site_dir, 'pages')
	let relative_path = path.relative(pages_dir, page_file)
	relative_path = relative_path.replaceAll('\\', '/')
	relative_path = relative_path.replace(/\.yaml$/i, '')

	if (relative_path === 'index') {
		return ''
	}

	if (relative_path.endsWith('/index')) {
		return relative_path.slice(0, -'/index'.length)
	}

	return relative_path
}

function escape_html(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;')
}

function safe_temp_id(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'page'
}

async function copy_dir(src: string, dest: string): Promise<void> {
	await fs.mkdir(dest, { recursive: true })
	const entries = await fs.readdir(src, { withFileTypes: true })

	for (const entry of entries) {
		const src_path = path.join(src, entry.name)
		const dest_path = path.join(dest, entry.name)

		if (entry.isDirectory()) {
			await copy_dir(src_path, dest_path)
		} else {
			await fs.copyFile(src_path, dest_path)
		}
	}
}

async function load_layout(site_dir: string, page_type: string): Promise<Layout> {
	const layout_path = path.join(site_dir, 'page-types', page_type, 'layout.yaml')
	try {
		const content = await fs.readFile(layout_path, 'utf-8')
		// A comment-only or empty layout.yaml parses to null/undefined — treat it
		// as an empty layout rather than crashing on `layout.header`.
		const parsed = load_yaml(content)
		return (parsed && typeof parsed === 'object' ? parsed : {}) as Layout
	} catch {
		// No layout file, return empty layout
		return {}
	}
}

async function resolve_layout_sections(sections: PageSection[], site_dir: string, site_data: SiteData, page_url_map: Map<string, string>, current_page_id?: string): Promise<PageSection[]> {
	// For layout sections without content, load from block's content.yaml
	const resolved: PageSection[] = []
	for (const section of sections) {
		let content: Record<string, unknown>
		if (section.content && Object.keys(section.content).length > 0) {
			content = section.content
		} else {
			// Try to load default content from block's content.yaml
			content = await load_block_defaults(site_dir, section.block)
		}
		// Resolve any site-field references in the content
		const site_resolved = await resolve_site_fields(site_dir, section.block, content, site_data)
		// Convert stored values (images, rich text, ...) into what the block receives
		const resolved_content = resolve_field_values(await load_block_fields(site_dir, section.block), site_resolved, site_data)
		// Resolve internal page: links to URLs (walks nested repeaters/groups too)
		resolved.push({ ...section, content: resolve_links(resolved_content, page_url_map, current_page_id) as Record<string, unknown> })
	}
	return resolved
}

async function resolve_page_sections(sections: PageSection[], site_dir: string, site_data: SiteData, page_url_map: Map<string, string>, current_page_id?: string): Promise<PageSection[]> {
	// Resolve site-field references in page sections. Like layout sections, a
	// page section with no content of its own falls back to the block's
	// content.yaml defaults, so a file-authored section renders its defaults
	// instead of nothing.
	const resolved: PageSection[] = []
	for (const section of sections) {
		let content: Record<string, unknown>
		if (section.content && Object.keys(section.content).length > 0) {
			content = section.content
		} else {
			content = await load_block_defaults(site_dir, section.block)
		}
		const site_resolved = await resolve_site_fields(site_dir, section.block, content, site_data)
		const resolved_content = resolve_field_values(await load_block_fields(site_dir, section.block), site_resolved, site_data)
		// Resolve internal page: links to URLs (walks nested repeaters/groups too)
		resolved.push({ ...section, content: resolve_links(resolved_content, page_url_map, current_page_id) as Record<string, unknown> })
	}
	return resolved
}

// Build a map of page _id -> live URL path. The URL is derived from the page
// file's location (the same convention used to write output HTML), so a
// `page:` reference resolves to exactly the path that page is deployed at.
async function build_page_url_map(site_dir: string, page_files: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	for (const page_file of page_files) {
		try {
			const page = load_yaml(await fs.readFile(page_file, 'utf-8')) as Page
			const id = page._id || page.id
			if (!id) continue
			const page_path = get_page_path_from_file(site_dir, page_file)
			map.set(id, page_path === '' ? '/' : `/${page_path}`)
		} catch {
			// Skip unparseable page files; they'll surface elsewhere in the build.
		}
	}
	return map
}

// Recursively resolve internal `page:` links to their URL. Walks arbitrarily
// nested content (repeaters, groups, page-lists), so links inside a
// site-field-referenced repeater resolve the same as top-level link fields.
//
// A link value is any object carrying a `page` id. We look the id up in the
// page URL map and populate `url`:
//   - known page id      -> the page's live URL
//   - missing/deleted id -> '' (degrades to href="#" downstream, never crashes)
// `active` is derived per page, never taken from stored content. Raw URL links
// are inactive; every other key on the link object (label, etc.) is preserved.
function resolve_links(value: unknown, page_url_map: Map<string, string>, current_page_id?: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => resolve_links(item, page_url_map, current_page_id))
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>
		// A link with a page reference: resolve it to a URL.
		if (typeof obj.page === 'string' && obj.page) {
			const url = page_url_map.get(obj.page) ?? ''
			return { ...obj, url, active: !!url && obj.page === current_page_id }
		}
		// URL-only and empty page-reference links have no current-page state.
		if (typeof obj.page === 'string' || (typeof obj.url === 'string' && ('label' in obj || 'text' in obj || 'active' in obj))) {
			return { ...obj, active: false }
		}
		// Otherwise recurse into every value (covers repeater arrays, groups,
		// and the `{ link: {...} }` wrapper repeaters produce).
		const result: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(obj)) {
			result[key] = resolve_links(child, page_url_map, current_page_id)
		}
		return result
	}
	return value
}

function is_plain_object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

// Convert stored field values into what blocks and head fragments receive,
// by field type, as server publish does (see the CMS's Content.svelte.ts).
// Walks repeater/group subfields; keys without a field definition pass
// through unchanged, fields without a value get the server's empty value.
// Returns new objects, never mutates `content`.
function resolve_field_values(
	fields: Array<SiteField | BlockField>,
	content: Record<string, unknown>,
	context: FieldContext
): Record<string, unknown> {
	const resolved: Record<string, unknown> = { ...content }
	for (const field of fields as BlockField[]) {
		if (!field?.name) continue
		// Derived from other pages, never from a stored value
		if (field.type === 'page-list' || field.type === 'page-field') {
			const value = field.type === 'page-list' ? resolve_page_list(field, context) : resolve_page_field(field, context)
			if (value === undefined) delete resolved[field.name]
			else resolved[field.name] = value
			continue
		}
		if (resolved[field.name] === undefined) {
			const empty = empty_field_value(field)
			if (empty !== undefined) resolved[field.name] = empty
			continue
		}
		const value = resolved[field.name]
		const subfields = Array.isArray(field.subfields) ? field.subfields : []
		if (field.type === 'image') {
			resolved[field.name] = resolve_image(value, context.uploads)
		} else if (field.type === 'rich-text') {
			resolved[field.name] = rich_text_to_html(value)
		} else if (field.type === 'markdown' && typeof value === 'string') {
			resolved[field.name] = markdown_to_html(value)
		} else if (field.type === 'page') {
			const page = typeof value === 'string' ? context.pages.find((candidate) => candidate.id === value) : undefined
			const page_value = page && resolve_page_reference(page, context)
			if (page_value === undefined) delete resolved[field.name]
			else resolved[field.name] = page_value
		} else if (field.type === 'repeater' && Array.isArray(value)) {
			resolved[field.name] = value.map((item) => is_plain_object(item) ? resolve_field_values(subfields, item, context) : item)
		} else if (field.type === 'group' && is_plain_object(value)) {
			resolved[field.name] = resolve_field_values(subfields, value, context)
		}
	}
	return resolved
}

// A referenced page as server publish passes it: the page's resolved fields
// plus _meta. created_at has no source in site files and stays unset.
// Undefined for a page that (indirectly) references itself.
function resolve_page_reference(page: SitePage, context: FieldContext): Record<string, unknown> | undefined {
	const key = page.id || `/${page.page_path}`
	if (!context.page_content.has(key)) {
		context.page_content.set(key, undefined)
		const fields = context.page_types.get(page.page_type)?.fields || []
		context.page_content.set(key, resolve_field_values(fields, page.fields, { ...context, current_page: undefined }))
	}
	const data = context.page_content.get(key)
	if (!data) return undefined
	return {
		...data,
		_meta: {
			created_at: undefined,
			name: page.name,
			slug: page.page_path.split('/').pop() || '',
			url: page.page_path === '' ? '/' : `/${page.page_path}`
		}
	}
}

// Every page of the configured page type (its folder name, or its _id).
function resolve_page_list(field: BlockField, context: FieldContext): unknown[] | undefined {
	const ref = field.config?.page_type
	if (typeof ref !== 'string' || !ref) return undefined
	const folder = context.page_types.has(ref) ? ref : [...context.page_types].find(([, page_type]) => page_type.id === ref)?.[0]
	if (!folder) return undefined
	const pages = context.pages.filter((page) => page.page_type === folder).map((page) => resolve_page_reference(page, context))
	// Like the server: no pages leaves the field unset
	return pages.length > 0 && pages.every(Boolean) ? pages : undefined
}

// A page type field, read from the page being rendered (or its empty value).
// The reference is `<page-type-folder>--<field-key>`, a field _id, or a bare
// key only one page type defines.
function resolve_page_field(field: BlockField, context: FieldContext): unknown {
	const ref = field.config?.field
	if (typeof ref !== 'string' || !ref || !context.current_page) return undefined
	let page_field: BlockField | undefined
	const separator = ref.indexOf('--')
	if (separator >= 0) {
		const key = ref.slice(separator + 2)
		page_field = context.page_types.get(ref.slice(0, separator))?.fields.find((candidate) => candidate.name === key)
	} else {
		const all_fields = [...context.page_types.values()].flatMap((page_type) => page_type.fields)
		const by_key = all_fields.filter((candidate) => candidate.name === ref)
		page_field = all_fields.find((candidate) => get_field_id(candidate) === ref) ?? (by_key.length === 1 ? by_key[0] : undefined)
	}
	if (!page_field?.name) return undefined
	return context.current_page[page_field.name] ?? empty_field_value(page_field)
}

// What server publish hands a block for a field with no value, so blocks can
// read e.g. `image.url` on any section. Site references are resolved
// elsewhere and stay undefined. An empty rich-text field is '' here; the
// server passes an empty tiptap doc object.
function empty_field_value(field: BlockField): unknown {
	switch (field.type) {
		case 'image': return { url: '', src: '', alt: '', size: null, width: null, height: null }
		case 'link': return { url: '', label: '', text: '', active: false }
		case 'repeater': return []
		case 'group': return {}
		case 'switch': return true
		case 'number': return 0
		case 'info': return null
		case 'page': return null
		case 'site-field':
		case 'page-field':
		case 'page-list': return undefined
		default: return ''
	}
}

// An image's own url wins; otherwise its upload resolves to the copy of the
// file the build writes to /uploads/. `upload` is either a manifest ID (as
// pulled from the hosted server) or a symbolic `uploads/<file>` path.
function resolve_image(value: unknown, uploads: Map<string, string>): unknown {
	if (!is_plain_object(value) || (typeof value.url === 'string' && value.url)) return value
	const upload = typeof value.upload === 'string' ? value.upload : ''
	const upload_path = upload.startsWith('uploads/') ? upload : uploads.get(upload)
	if (!upload_path) return value
	return { ...value, url: `/${upload_path.split('/').map(encodeURIComponent).join('/')}` }
}

async function load_block_defaults(site_dir: string, block_name: string): Promise<Record<string, unknown>> {
	const content_path = path.join(site_dir, 'blocks', block_name, 'content.yaml')
	try {
		const content = await fs.readFile(content_path, 'utf-8')
		return (load_yaml(content) as Record<string, unknown>) || {}
	} catch {
		return {}
	}
}

async function load_fields_file(file_path: string): Promise<unknown> {
	const data = await fs.readFile(file_path, 'utf-8')
	return load_yaml(data)
}

function extract_fields_array(data: unknown): BlockField[] {
	if (Array.isArray(data)) {
		return data as BlockField[]
	}

	if (data && typeof data === 'object' && Array.isArray((data as { fields?: unknown[] }).fields)) {
		return (data as { fields: BlockField[] }).fields
	}

	return []
}

function get_field_id(field: { id?: string; _id?: string }): string | undefined {
	return field._id || field.id
}

async function load_site_data(site_dir: string, page_files: string[]): Promise<SiteData> {
	const fields_path = path.join(site_dir, 'site', 'fields.yaml')
	const content_path = path.join(site_dir, 'site', 'content.yaml')

	let fields: SiteField[] = []
	let content: Record<string, unknown> = {}

	try {
		fields = extract_fields_array(await load_fields_file(fields_path)) as SiteField[]
	} catch {
		// No site fields defined
	}

	try {
		const content_data = await fs.readFile(content_path, 'utf-8')
		content = (load_yaml(content_data) as Record<string, unknown>) || {}
	} catch {
		// No site content defined
	}

	// Images referencing uploads by ID resolve through the manifest. Without a
	// readable one only symbolic `uploads/<file>` references resolve.
	let uploads = new Map<string, string>()
	try {
		uploads = await read_upload_paths(site_dir)
	} catch (error) {
		console.log(chalk.yellow(`  Warning: could not read uploads/.manifest.json: ${error instanceof Error ? error.message : error}`))
	}
	const page_types = new Map<string, { id?: string; fields: BlockField[] }>()
	let page_type_folders: string[] = []
	try {
		page_type_folders = (await fs.readdir(path.join(site_dir, 'page-types'), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
			.map((entry) => entry.name)
	} catch {
		// No page types
	}
	for (const folder of page_type_folders) {
		let id: string | undefined
		try {
			const config = load_yaml(await fs.readFile(path.join(site_dir, 'page-types', folder, 'config.yaml'), 'utf-8')) as { _id?: unknown } | null
			if (typeof config?._id === 'string' && config._id) id = config._id
		} catch {
			// No config; the folder name still identifies the page type
		}
		page_types.set(folder, { id, fields: await load_page_type_fields(site_dir, folder) })
	}

	const pages: SitePage[] = []
	for (const page_file of page_files) {
		try {
			const page = load_yaml(await fs.readFile(page_file, 'utf-8')) as Page
			pages.push({
				id: page._id || page.id,
				name: page.name,
				page_path: get_page_path_from_file(site_dir, page_file),
				page_type: page.page_type || 'default',
				fields: is_plain_object(page.fields) ? page.fields : {}
			})
		} catch {
			// Unparseable page files surface when that page is built
		}
	}

	const context: FieldContext = { uploads, pages, page_types, page_content: new Map() }
	return { ...context, fields, content: resolve_field_values(fields, content, context) }
}

async function load_block_fields(site_dir: string, block_name: string): Promise<BlockField[]> {
	const fields_path = path.join(site_dir, 'blocks', block_name, 'fields.yaml')

	try {
		return extract_fields_array(await load_fields_file(fields_path))
	} catch {
		return []
	}
}

const page_type_fields_cache = new Map<string, BlockField[]>()

async function load_page_type_fields(site_dir: string, page_type: string): Promise<BlockField[]> {
	const cache_key = `${site_dir}:${page_type}`
	const cached = page_type_fields_cache.get(cache_key)
	if (cached !== undefined) return cached

	let fields: BlockField[] = []
	try {
		fields = extract_fields_array(await load_fields_file(path.join(site_dir, 'page-types', page_type, 'fields.yaml')))
	} catch {
		// No fields file for this page type
	}
	page_type_fields_cache.set(cache_key, fields)
	return fields
}

async function resolve_site_fields(
	site_dir: string,
	block_name: string,
	content: Record<string, unknown>,
	site_data: SiteData
): Promise<Record<string, unknown>> {
	// Load block field definitions to check for site-field types
	const block_fields = await load_block_fields(site_dir, block_name)

	// Create maps for site field lookup
	const site_field_id_map = new Map<string, string>() // ID -> name
	const site_field_name_set = new Set<string>() // names that exist
	for (const site_field of site_data.fields) {
		const site_field_id = get_field_id(site_field)
		if (site_field_id) {
			site_field_id_map.set(site_field_id, site_field.name)
		}
		site_field_name_set.add(site_field.name)
	}

	// Resolve site-field references in content
	const resolved: Record<string, unknown> = { ...content }

	// For each block field that is type site-field, resolve its value
	for (const field of block_fields) {
		if (field.type !== 'site-field') continue

		const field_ref = field.config?.field

		if (field_ref) {
			// Field reference can be either a name or an ID
			// Try as name first (new format)
			if (site_field_name_set.has(field_ref) && site_data.content[field_ref] !== undefined) {
				resolved[field.name] = site_data.content[field_ref]
				continue
			}
			// Try as ID (old format)
			const site_field_name = site_field_id_map.get(field_ref)
			if (site_field_name && site_data.content[site_field_name] !== undefined) {
				resolved[field.name] = site_data.content[site_field_name]
				continue
			}
		}

		// Fallback: if block field name matches a site field name, use that value
		if (site_field_name_set.has(field.name) && site_data.content[field.name] !== undefined) {
			resolved[field.name] = site_data.content[field.name]
		}
	}

	return resolved
}

// Pin every `svelte` and `svelte/*` import (compiler output and block code
// like `svelte/transition`) to the CLI's own svelte, resolved through its
// package.json exports for the bundle's platform. Hardcoded file aliases broke
// on svelte 5, which has no src/index.js, and mangled subpath imports.
function svelte_resolver(svelte_base: string): esbuild.Plugin {
	return {
		name: 'primo-svelte',
		setup(build) {
			build.onResolve({ filter: /^svelte(\/|$)/ }, (args) => {
				if (args.pluginData?.primo_svelte) return undefined
				return build.resolve(args.path, {
					kind: args.kind,
					resolveDir: path.dirname(svelte_base),
					pluginData: { primo_svelte: true }
				})
			})
		}
	}
}

async function find_svelte_path(): Promise<string> {
	// Try to find svelte in various locations
	const possible_paths = [
		// In primo-cli's node_modules (when npm linked or installed globally)
		path.join(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/svelte'),
		// In the current project's node_modules
		path.join(process.cwd(), 'node_modules/svelte'),
		// Try resolving from this file's location
		path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../node_modules/svelte')
	]

	for (const p of possible_paths) {
		try {
			await fs.access(p)
			return p
		} catch {
			// Continue to next path
		}
	}

	throw new Error('Could not find svelte package. Make sure svelte is installed.')
}
