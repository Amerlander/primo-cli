import { resolve_dev_server } from '../utils/dev-runtime.js'
import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import { VALID_FIELD_TYPES } from './validate.js'
import ora from 'ora'
import inquirer from 'inquirer'
import { dev_server } from './dev.js'
import { build_site_preview } from './preview.js'
import { SITE_CONFIG_FILE, write_site_config } from '../utils/site-config.js'
import { derive_display_name } from '../utils/site-name.js'
import { SERVER_CONFIG_FILE, read_server_config, write_server_config } from '../utils/server-config.js'

interface NewOptions {
	name?: string
	template?: string
	skipDev?: boolean
}

export async function new_site(options: NewOptions) {
	const base_dir = process.cwd()
	const server_config_path = path.join(base_dir, SERVER_CONFIG_FILE)
	const site_config_path = path.join(base_dir, SITE_CONFIG_FILE)
	const sites_dir = path.join(base_dir, 'sites')
	const library_dir = path.join(base_dir, 'library')

	try {
		await fs.access(site_config_path)
		console.log(chalk.red(`Found ${SITE_CONFIG_FILE} in the current directory.`))
		console.log(chalk.red('Run `primo new` from a workspace root, not inside a site directory.'))
		process.exit(1)
	} catch {
		// Not inside a site directory, continue.
	}

	// Require an initialized workspace
	try {
		await fs.access(server_config_path)
	} catch {
		console.log(chalk.red(`No ${SERVER_CONFIG_FILE} found in the current directory.`))
		console.log(chalk.dim('Run `primo init [name]` first to create a workspace.'))
		process.exit(1)
	}

	await fs.mkdir(sites_dir, { recursive: true })
	await fs.mkdir(library_dir, { recursive: true })

	const server_config = await read_server_config(base_dir)
	const site_groups = server_config.site_groups ?? []
	if (!site_groups.some((group) => group.id === 'default')) {
		site_groups.push({
			id: 'default',
			name: 'Default',
			index: site_groups.length
		})
		await write_server_config(base_dir, { ...server_config, site_groups })
	}

	let site_name = options.name

	// Prompt for name if not provided
	if (!site_name) {
		const { name } = await inquirer.prompt([{
			type: 'input',
			name: 'name',
			message: 'Site name:',
			default: 'my-site',
			validate: validate_site_name
		}])
		site_name = name
	} else {
		// A name passed as a CLI arg skips the prompt — validate it too, or a
		// name like `.foo` slips through: it makes a hidden sites/.foo dir that
		// discover_sites ignores, and an empty display_name downstream.
		const error = validate_site_name(site_name)
		if (error !== true) {
			console.log(chalk.red(error))
			process.exit(1)
		}
	}

	// Always create site in sites/<name>
	const site_dir = path.join(sites_dir, site_name!)

	// Check if directory exists
	try {
		await fs.access(site_dir)
		console.log(chalk.red(`Directory "${site_name}" already exists`))
		process.exit(1)
	} catch {
		// Directory doesn't exist, good to proceed
	}

	const spinner = ora('Creating site...').start()

	try {
		// Create directory structure
		await fs.mkdir(site_dir, { recursive: true })
		await fs.mkdir(path.join(site_dir, 'blocks'), { recursive: true })
		await fs.mkdir(path.join(site_dir, 'pages'), { recursive: true })
		await fs.mkdir(path.join(site_dir, 'page-types', 'default'), { recursive: true })
		await fs.mkdir(path.join(site_dir, 'site'), { recursive: true })

		// Create site config
		// If name has dots (hostname), use first part capitalized as display name
		const display_name = derive_display_name(site_name!)
		const config = {
			name: display_name,
			site_id: generate_id(),
			group: 'default'
		}
		await write_site_config(site_dir, config)

		// Create default page type config + sibling fields.yaml + head.svelte.
		// No `_id`s anywhere in the scaffold: the server mints and writes them
		// back on first import (see AGENTS.md). Hand-authoring ids here
		// contradicts that rule and masks the write-back path.
		const page_type_config = {
			name: 'Default',
			icon: 'mdi:file-document-outline',
			color: '#2B407D',
			allowed_blocks: ['hero']
		}
		await fs.writeFile(
			path.join(site_dir, 'page-types', 'default', 'config.yaml'),
			`name: ${page_type_config.name}
icon: ${page_type_config.icon}
color: "${page_type_config.color}"
allowed_blocks:
  - hero
`
		)
		await fs.writeFile(
			path.join(site_dir, 'page-types', 'default', 'fields.yaml'),
			`- name: seo_title
  label: SEO Title
  type: text
- name: seo_description
  label: SEO Description
  type: text
- name: og_image
  label: Social Share Image
  type: image
`
		)
		// Injected into <svelte:head> by Primo — do NOT wrap it in one.
		await fs.writeFile(
			path.join(site_dir, 'page-types', 'default', 'head.svelte'),
			`<title>{seo_title || 'New site'}</title>
<meta name="description" content={seo_description || ''} />
<meta property="og:type" content="website" />
<meta property="og:title" content={seo_title || 'New site'} />
<meta property="og:description" content={seo_description || ''} />
{#if og_image?.url}
	<meta property="og:image" content={og_image.url} />
{/if}
`
		)
		await fs.writeFile(
			path.join(site_dir, 'page-types', 'default', 'layout.yaml'),
			`# Sections shared by every page of this type. Add blocks here to render
# the same header/footer across all pages of this type. Body sections are
# seeded onto each newly created page of this type (and locked when the type
# has no allowed_blocks).
#
# header:
#   - block: site-header
# body:
#   - block: hero
# footer:
#   - block: site-footer
`
		)

		// Create site fields (empty array)
		await fs.writeFile(
			path.join(site_dir, 'site', 'fields.yaml'),
			'[]\n'
		)

		// Create site content (empty)
		await fs.writeFile(
			path.join(site_dir, 'site', 'content.yaml'),
			'# Site-wide content\n'
		)

		// Create site head with CSS variables
		await fs.writeFile(
			path.join(site_dir, 'site', 'head.svelte'),
			`<style>
:root {
	--theme-primary: #6366f1;
	--theme-primary-dark: #4f46e5;
	--theme-background: #ffffff;
	--theme-background-secondary: #f8fafc;
	--theme-text: #0f172a;
	--theme-text-muted: #64748b;
	--theme-border-color: #e2e8f0;
	--theme-heading-font: system-ui, -apple-system, sans-serif;
	--theme-body-font: system-ui, -apple-system, sans-serif;
	--theme-section-padding: 5rem;
}
</style>
`
		)

		// Create starter hero block (4 files: config + fields + content + component)
		await fs.mkdir(path.join(site_dir, 'blocks', 'hero'), { recursive: true })

		await fs.writeFile(
			path.join(site_dir, 'blocks', 'hero', 'config.yaml'),
			`name: Hero
`
		)

		await fs.writeFile(
			path.join(site_dir, 'blocks', 'hero', 'fields.yaml'),
			`- name: headline
  label: Headline
  type: text
- name: subheadline
  label: Subheadline
  type: text
- name: cta
  label: Call to Action
  type: link
`
		)

		await fs.writeFile(
			path.join(site_dir, 'blocks', 'hero', 'component.svelte'),
			`<section class="hero">
	<div class="container">
		<h1>{headline}</h1>
		{#if subheadline}
			<p class="subheadline">{subheadline}</p>
		{/if}
		{#if cta?.url}
			<a href={cta.url} class="btn">{cta.label}</a>
		{/if}
	</div>
</section>

<script>
	let { headline = '', subheadline = '', cta = {} } = $props()
</script>

<style>
	.hero {
		padding: var(--theme-section-padding, 5rem) 0;
		background: var(--theme-background-secondary, #f8fafc);
		text-align: center;
	}

	.container {
		max-width: 800px;
		margin: 0 auto;
		padding: 0 1.5rem;
	}

	h1 {
		font-family: var(--theme-heading-font, system-ui);
		font-size: clamp(2rem, 5vw, 3.5rem);
		font-weight: 700;
		color: var(--theme-text, #0f172a);
		margin: 0 0 1rem;
		line-height: 1.1;
	}

	.subheadline {
		font-size: 1.25rem;
		color: var(--theme-text-muted, #64748b);
		margin: 0 0 2rem;
	}

	.btn {
		display: inline-block;
		padding: 0.875rem 2rem;
		background: var(--theme-primary, #6366f1);
		color: white;
		text-decoration: none;
		border-radius: 0.5rem;
		font-weight: 500;
		transition: background 0.2s;
	}

	.btn:hover {
		background: var(--theme-primary-dark, #4f46e5);
	}
</style>
`
		)

		await fs.writeFile(
			path.join(site_dir, 'blocks', 'hero', 'content.yaml'),
			`headline: Welcome to ${display_name}
subheadline: Edit this content in your local files or CMS
cta:
  label: Get Started
  url: "#"
`
		)

		// Create index page
		await fs.writeFile(
			path.join(site_dir, 'pages', 'index.yaml'),
			`name: Home
page_type: default
fields: {}
sections:
  - block: hero
    content:
      headline: Welcome to ${display_name}
      subheadline: Edit this content in your local files or CMS
      cta:
        label: Get Started
        url: "#"
`
		)

		// Workspace-level agent guidance (per-site AGENTS.md is generated by
		// `export.go` for portable exports; in a workspace one file covers all).
		await ensure_agent_files(base_dir)

		spinner.succeed(`Site created: ${chalk.cyan(site_dir)}`)

		const { port, running: server_running } = await resolve_dev_server(base_dir, server_config.port)

		if (server_running) {
			// A `primo dev` is already running. Ask it to reload and pick up the
			// new site. The dev server prints its own "New site loaded" + links,
			// but in *its* terminal — so print the same links here too, otherwise
			// this terminal looks like nothing happened.
			// Host is derived from the display name (what becomes config.name),
			// matching how dev_server builds the host — not the raw folder name.
			const host = local_dev_host(display_name, port)
			let outcome: 'reloaded' | 'quarantined' | 'unreachable' = 'unreachable'
			try {
				// Bound the request: the reload handler runs discovery + import
				// synchronously before responding, so an unbounded fetch could
				// hang here forever and never reach the warning below.
				const controller = new AbortController()
				const timeout = setTimeout(() => controller.abort(), 30000)
				let res: Response
				try {
					res = await fetch(`http://127.0.0.1:${port + 1}/reload`, {
						method: 'POST',
						signal: controller.signal
					})
				} finally {
					clearTimeout(timeout)
				}
				if (res.ok) {
					// A 2xx no longer implies the site imported — the handler
					// returns { quarantined: [...] } for sites it couldn't load
					// (duplicate _ids). Parse the body to tell the difference.
					const result = await res.json().catch(() => null) as
						| { quarantined?: string[] }
						| null
					outcome = result?.quarantined?.includes(display_name)
						? 'quarantined'
						: 'reloaded'
				}
			} catch {
				// Reload server not running (older `primo dev`, hot reload disabled
				// because the port was in use) or the request timed out. Site files
				// are on disk; restarting `primo dev` will pick them up.
			}

			if (outcome === 'reloaded') {
				// Generate the preview before printing the URL, so the URL we show
				// actually serves the site. Until a preview is built the site URL
				// redirects to /admin.
				let preview_url: string | null = null
				try {
					const built = await build_site_preview(site_dir, `http://127.0.0.1:${port}`)
					preview_url = built.site_url
				} catch {
					// Compiler unavailable, or the build failed — the site is on disk.
				}
				console.log('')
				console.log(`  ${chalk.cyan(display_name)}`)
				console.log(`    ${chalk.dim('Edit:')}    http://${host}/admin/site`)
				console.log(
					preview_url
						? `    ${chalk.dim('Preview:')} ${preview_url}`
						: `    ${chalk.dim('Preview:')} not built yet — run ${chalk.cyan('primo preview')}, or Build Preview in the dashboard`
				)
				console.log('')
			} else if (outcome === 'quarantined') {
				console.log('')
				console.log(chalk.yellow(`  ${display_name} was created, but the dev server couldn't import it (duplicate IDs).`))
				console.log(chalk.dim('  Fix the conflict, then restart `primo dev` to pick it up.'))
				console.log('')
			} else {
				console.log('')
				console.log(chalk.yellow(`  ${display_name} was created on disk, but the running dev server didn't import it.`))
				console.log(chalk.dim('  The reload endpoint didn\'t respond (hot reload may be disabled).'))
				console.log(chalk.dim('  Restart `primo dev` to pick up the new site, or stop it and run `primo add <name>`.'))
				console.log('')
			}
		} else if (!options.skipDev && process.stdin.isTTY && process.stdout.isTTY && !is_ci()) {
			// No server running, start one. It runs in the foreground until
			// Ctrl+C, so say so up front.
			console.log('')
			console.log(chalk.dim('  Starting the local CMS (runs until you press Ctrl+C; pass --skip-dev to only create files)...'))
			await dev_server({ dir: base_dir })
		} else if (!options.skipDev) {
			// Not an interactive terminal, or CI (an agent, script, or CI job): starting a
			// server that never returns would hang the caller, so create the
			// files and say how to start it.
			console.log('')
			console.log(`  ${display_name} was created. Start the local CMS to import it:`)
			console.log(chalk.dim('    primo dev    (runs until stopped; run it in the background from scripts)'))
			console.log('')
		} else {
			console.log('')
			console.log(chalk.dim(`  ${display_name} was created. It loads into the CMS the next time you start it:`))
			console.log(chalk.dim('    primo dev'))
			console.log('')
		}

	} catch (error) {
		spinner.fail(`Failed to create site: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}
}

// CI runners can allocate a pseudo-terminal, so a TTY alone doesn't mean a
// person is there to stop a foreground server.
function is_ci(): boolean {
	return ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TRAVIS', 'JENKINS_URL', 'TEAMCITY_VERSION']
		.some(name => !!process.env[name] && process.env[name] !== 'false')
}

// Shared name validation for both the interactive prompt and the CLI arg.
// Returns `true` when valid, or an error string (inquirer's contract).
// Leading dots/hyphens are rejected: a leading dot makes a hidden sites/.<name>
// directory that discover_sites skips, and strips display_name to empty.
function validate_site_name(input: string): true | string {
	if (!input.trim()) return 'Name is required'
	if (!/^[a-z0-9.-]+$/i.test(input)) return 'Use only letters, numbers, dots, and hyphens'
	if (/^[.-]/.test(input)) return 'Name can\'t start with a dot or hyphen'
	return true
}

// Mirror of dev.ts's local_dev_host: slug the display name into a
// `<slug>.localhost:<port>` host so the links printed here match the ones
// `primo dev` prints for the same site.
function local_dev_host(name: string, port: number): string {
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site'
	return `${slug}.localhost:${port}`
}

function generate_id(): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
	let id = ''
	for (let i = 0; i < 15; i++) {
		id += chars[Math.floor(Math.random() * chars.length)]
	}
	return id
}

// Write the workspace AGENTS.md, plus a CLAUDE.md that imports it: Claude
// Code loads CLAUDE.md automatically but not AGENTS.md, and release-test
// agents never found the guidance on their own. Never clobbers either file.
export async function ensure_agent_files(dir: string): Promise<void> {
	const files: Array<[string, () => string]> = [
		['AGENTS.md', generate_agent_md],
		['CLAUDE.md', () => '# Primo workspace\n\nClaude Code loads the line below as an import of this workspace\'s agent guide.\n\n@AGENTS.md\n']
	]
	for (const [name, contents] of files) {
		const file = path.join(dir, name)
		try {
			await fs.access(file)
		} catch {
			await fs.writeFile(file, contents())
		}
	}
}

export function generate_agent_md(): string {
	return `# Primo workspace

Primo workspace for local development. Each subdirectory under \`sites/\` is an independent Primo site.

The Primo MCP server (\`primo\`) is the source of truth, when present, for schema, validation, field types, and inline editing. Call \`list_docs\` first to see what's documented.

Without the MCP server, read \`sites/*/blocks/*/fields.yaml\` and \`sites/*/page-types/*/fields.yaml\` to infer schemas, and treat \`sites/*/pages/*.yaml\` page/section \`content:\` as the source of truth for rendered content (block \`content.yaml\` files are defaults only).

## Layout

- \`server.yaml\` — workspace config and site groups
- \`sites/<name>/\` — individual sites (\`site.yaml\`, \`site/\`, \`blocks/\`, \`page-types/\`, \`pages/\`, \`.primo/\`)
- \`library/\` — shared library content

## Setup

- \`primo dev\` — start the local CMS and dev server. Run from the workspace root. It runs until stopped; from scripts or agents, run it in the background and stop it by PID.
- \`primo new [name]\` — scaffold a new site under \`sites/\`. In an interactive terminal it then starts the CMS; add \`--skip-dev\` to only create files.
- \`primo add <name>\` — register an existing \`sites/<name>\` folder with the CMS (mints its site_id and imports its records). Creating the folder alone doesn't register it. Stop \`primo dev\` first, then start it again afterwards. A folder copied from another site gets fresh ids automatically.
- \`primo preview --dir sites/<name>\` — build that site's preview (needs \`primo dev\` running). Until a site's preview is built, its preview URL shows the CMS instead; rebuild after edits to see them there.
- File edits sync automatically while \`primo dev\` is running. Structural changes (block schema, component) may trigger a browser reload.

## Shared library

- \`library/\` holds blocks shared across sites: \`library/groups.yaml\` lists groups (\`- name: Shared\` / \`folder: shared\`), and each block lives in \`library/<group-folder>/<block>/\` with the same files as a site block.
- \`primo dev\` loads the library into the CMS; editors add a library block to a site from the editor's block picker, which copies it into that site.
- In files, use a library block on a site by copying its folder into \`sites/<name>/blocks/\` (omit its \`_id\`). Copies are independent afterwards.

## Source of truth

- Editable source lives in \`sites/<name>/site.yaml\`, \`site/\`, \`blocks/\`, \`page-types/\`, and \`pages/\`.
- \`.primo/\` is generated local state (SQLite + uploads). Do not edit, do not commit.
- Do not patch the SQLite DB to fix schema or content issues. Edit the source files; the dev server reimports.
- If local state seems wrong, delete \`.primo/\` and let the dev server reimport from files.

## Recovering overwritten files

When \`primo dev\` syncs CMS changes to disk, the prior file content is copied to \`.primo/trash/\` before the overwrite or delete. Entries are kept for 7 days.

If a file appears to have lost content after a sync (deleted entries, shrunken YAML lists, missing sections, removed files), check \`.primo/trash/\` for the most recent copy and restore with \`cp\`. The dev server also annotates the change log when a synced file shrinks or is deleted.

## IDs

- Top-level entities use system-owned \`_id\` keys (pages, sections, blocks, page types, fields).
- For blocks, \`_id\` lives in \`blocks/<key>/config.yaml\`. For page types, in \`page-types/<key>/config.yaml\`. The folder name is the stable reference key — editing \`name\` in \`config.yaml\` only changes the editor display label.
- When creating a new entity, omit the ID. The dev server generates and writes it back on first sync.
- Do not invent or hand-author IDs. Keep existing IDs stable when editing.
- Duplicate IDs are treated as conflicts; affected files may be skipped.

## Routing

- Page slugs come from the file path under \`pages/\`, not a \`slug:\` key.
- \`pages/index.yaml\` → \`/\`, \`pages/about.yaml\` → \`/about\`, \`pages/about/team.yaml\` → \`/about/team\`.
- Do not add \`slug:\` to page files. It is ignored.

## Fields

- Field types: ${VALID_FIELD_TYPES.map(type => `\`${type}\``).join(', ')}. Anything else fails validation.
- Nested fields of a \`repeater\` or \`group\` in block or site field definitions go under \`subfields:\` (not \`fields:\`). Page-type fields don't support nested fields.
- \`site-field\` references a site field by name: \`config: { field: <site-field-name> }\`.
- \`page-field\` references a page type field as \`<page-type-folder>--<field-key>\`, e.g. \`config: { field: blog-post--author }\`.
- \`url\` holds a plain string (\`/about\`, \`https://...\`). \`link\` holds \`{ label, url }\`; a \`url\` that matches a page path is stored as a reference to that page.
- Run \`primo validate\` (from the workspace root it checks every site) before assuming a schema change landed.

## Workflow

The tool calls below need the Primo MCP server. Without it, follow the content design checklist below and read the site's source files directly.

- Before creating a site or changing its content structure, call \`get_docs({section: 'recommended-defaults'})\` for field-scope decisions, block availability, page types, and the wiring checklist. Without MCP, use the content design checklist below.
- After editing a block file, call \`validate_block\`.
- After editing a page or page-type file, call \`validate_page\`.
- When creating a new block or page type, prefer \`scaffold_block\` / \`scaffold_page_type\`.
- Add a block to a page type's \`allowed_blocks\` only when editors should be able to insert another instance into the page body.
- For everything else, call \`get_docs\` with the relevant section, or read the relevant source files without MCP.
- Block components are Svelte 5. If the Svelte MCP server is available, use \`mcp__svelte__svelte-autofixer\` after editing \`.svelte\` files.

## Content design checklist

These defaults apply even without MCP. Adapt them to the site's needs and the user's instructions; inspect existing structure before adding new fields, blocks, or types.

- Site fields hold centrally managed values such as logo, navigation links, contact details, and social links. Reference them with \`site-field\` instead of copying values into sections.
- Page fields describe a page: title, summary, cover image, author, and SEO metadata. Define them on the page type, populate each page's \`fields:\`, and reference them with \`page-field\` where needed.
- Block fields hold section-specific content such as testimonials, feature lists, or CTA text. Existing section values live in the page's section \`content:\`; block \`content.yaml\` only supplies preview and insertion defaults.
- Put shared Navigation/Footer in the page type's \`layout.yaml\` under \`header:\`/\`footer:\`. Put a once-per-page Hero in page \`sections:\` or seed it through layout \`body:\`; body seeds only affect newly created pages.
- Block availability toggles (\`allowed_blocks\`) control the add-block picker. Normally leave Navigation, Footer, and once-per-page Hero off; enable sections editors should be able to add repeatedly. A hero-style section can be enabled if repetition is intentional. Excluding an individual block from the picker does not lock a section or enforce a one-instance limit, unless it was the last allowed block: an empty \`allowed_blocks\` list makes the type static and locks body structure.
- Reuse page types unless field schema, shared layout, or editing needs differ. An empty \`allowed_blocks\` list makes the type static with locked body structure; a non-empty list supports flexible composition. Avoid a new type for every page or minor visual variation.

## Permission prompts

Your MCP client may prompt before each Primo tool call. All Primo MCP tools are read-only or return scaffolds — they don't modify your files. To skip the prompts, allowlist the \`primo\` server in your client's MCP settings (mechanism varies by client).

---

# Project preferences

Fill in the sections below to give agents project-specific direction. Anything left blank is treated as "no preference."

## Design direction

<!-- e.g. warm earth tones, generous whitespace, system fonts, minimal animation -->

## Voice & tone

<!-- e.g. friendly but not casual, second-person, short sentences -->

## SEO preferences

<!-- e.g. always mention city in seo_description, target ~150 chars, prefer action verbs in titles -->

## Content guidelines

<!-- e.g. real customer names ok, no stock photos, prefer specific numbers over vague claims -->

## Other

<!-- e.g. accessibility targets, performance budgets, browser support, anything else agents should know -->
`
}
