import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { run_cli, make_workspace } from './helpers/run-cli.mjs'

/**
 * `primo build` must render blocks the way server publish does:
 *
 * - Blocks may import svelte subpaths (`svelte/transition`, `svelte/store`).
 * - Blocks that don't call $props() see their fields as bare identifiers.
 */

async function write_file(root, rel, content) {
	const full = path.join(root, rel)
	await fs.mkdir(path.dirname(full), { recursive: true })
	await fs.writeFile(full, content)
}

async function make_site(root, { fields, component, content }) {
	await write_file(root, 'site.yaml', 'name: Fixture\nsite_id: fixture00000001\ngroup: default\n')
	await write_file(root, 'site/head.svelte', '<title>Fixture</title>\n')
	await write_file(root, 'blocks/hero/config.yaml', 'name: Hero\n')
	await write_file(root, 'blocks/hero/fields.yaml', fields)
	await write_file(root, 'blocks/hero/component.svelte', component)
	await write_file(root, 'page-types/default/config.yaml', 'name: Default\n')
	await write_file(root, 'page-types/default/fields.yaml', '[]\n')
	await write_file(root, 'page-types/default/layout.yaml', '# stub\n')
	const indented = content.trimEnd().split('\n').map((line) => `      ${line}`).join('\n')
	await write_file(root, 'pages/index.yaml', `name: Home\npage_type: default\nfields: {}\nsections:\n  - _id: section0000001\n    block: hero\n    content:\n${indented}\n`)
}

async function build(site) {
	const workspace = await make_workspace()
	const site_dir = path.join(workspace.work, 'site')
	const out_dir = path.join(workspace.work, 'out')
	await make_site(site_dir, site)
	await site.setup?.(site_dir)
	const result = await run_cli(['build', '-d', site_dir, '-o', out_dir], { cwd: workspace.work, home: workspace.home })
	const html = await fs.readFile(path.join(out_dir, 'index.html'), 'utf8').catch(() => '')
	return { result, html, out_dir, cleanup: workspace.cleanup }
}

describe('primo build parity', () => {
	test('blocks can import svelte subpaths', async () => {
		const { result, html, cleanup } = await build({
			fields: '- name: headline\n  type: text\n',
			content: 'headline: Hello\n',
			component: [
				'<script>',
				"import { fade } from 'svelte/transition'",
				"import { writable } from 'svelte/store'",
				"import { cubicOut } from 'svelte/easing'",
				'let { headline } = $props()',
				'const count = writable(cubicOut(1))',
				'let open = $state(true)',
				'</script>',
				'<h1>{headline} {$count}</h1>',
				'{#if open}<p transition:fade>open</p>{/if}',
				''
			].join('\n')
		})
		try {
			assert.equal(result.code, 0, result.output)
			assert.match(html, /<h1>Hello 1<\/h1>/)
		} finally {
			await cleanup()
		}
	})

	test('blocks without $props() get their fields as props', async () => {
		const fields = '- name: headline\n  type: text\n- name: tagline\n  type: text\n'
		const content = 'headline: Hello\ntagline: World\n'
		const markup = await build({ fields, content, component: '<h1>{headline}</h1><p>{tagline}</p>\n' })
		const scripted = await build({
			fields,
			content,
			component: '<script module>export const meta = 1</script>\n<script>\nconst loud = $derived(headline.toUpperCase())\n</script>\n<h1>{loud}</h1><p>{tagline}</p>\n'
		})
		try {
			assert.equal(markup.result.code, 0, markup.result.output)
			assert.match(markup.html, /<h1>Hello<\/h1><p>World<\/p>/)
			assert.equal(scripted.result.code, 0, scripted.result.output)
			assert.match(scripted.html, /<h1>HELLO<\/h1><p>World<\/p>/)
		} finally {
			await markup.cleanup()
			await scripted.cleanup()
		}
	})
})
