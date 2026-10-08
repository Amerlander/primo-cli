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
 * - Image fields referencing an upload (manifest ID or `uploads/<file>`)
 *   get a url pointing at the copied file, in site content and sections.
 * - Rich-text (tiptap JSON or markdown) and markdown values become HTML.
 * - Fields without a value get the server's empty value instead of undefined.
 * - Pages use the server's markup: header/main/footer zones, section wrappers.
 * - Blocks with a script get a /_symbols bundle and are hydrated on the page.
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

	test('image uploads resolve to the copied /uploads files', async () => {
		const { result, html, out_dir, cleanup } = await build({
			fields: [
				'- name: image',
				'  type: image',
				'- name: external',
				'  type: image',
				'- name: gallery',
				'  type: repeater',
				'  subfields:',
				'    - name: card',
				'      type: group',
				'      subfields:',
				'        - name: photo',
				'          type: image',
				''
			].join('\n'),
			content: [
				'image:',
				'  upload: uploads/hero shot.jpg',
				"  url: ''",
				'  alt: Hero',
				'external:',
				'  upload: hostedid0000001',
				'  url: https://cdn.example.com/kept.png',
				'gallery:',
				'  - card:',
				'      photo:',
				'        upload: hostedid0000001',
				"        url: ''",
				''
			].join('\n'),
			component: [
				'<script>let { image, external, gallery } = $props()</script>',
				'<img class="hero" src={image.url} alt={image.alt}>',
				'<img class="external" src={external.url} alt="">',
				'{#each gallery as item}<img class="photo" src={item.card.photo.url} alt="">{/each}',
				''
			].join('\n'),
			async setup(site_dir) {
				await write_file(site_dir, 'uploads/hero shot.jpg', 'hero')
				await write_file(site_dir, 'uploads/logo.png', 'logo')
				await write_file(site_dir, 'uploads/.manifest.json', JSON.stringify({ 'logo.png': { id: 'hostedid0000001', hash: 'stale' } }))
				// Site-level image, shown by a layout section through a site-field.
				await write_file(site_dir, 'site/fields.yaml', '- name: logo\n  type: image\n')
				await write_file(site_dir, 'site/content.yaml', "logo:\n  upload: hostedid0000001\n  url: ''\n  alt: Logo\n")
				await write_file(site_dir, 'blocks/nav/fields.yaml', '- name: logo\n  type: site-field\n  config:\n    field: logo\n')
				await write_file(site_dir, 'blocks/nav/component.svelte', '<script>let { logo } = $props()</script>\n<nav><img src={logo.url} alt={logo.alt}></nav>\n')
				await write_file(site_dir, 'page-types/default/layout.yaml', 'header:\n  - block: nav\n')
			}
		})
		try {
			assert.equal(result.code, 0, result.output)
			assert.match(html, /<nav><img src="\/uploads\/logo\.png" alt="Logo"\/?><\/nav>/)
			assert.match(html, /class="hero" src="\/uploads\/hero%20shot\.jpg" alt="Hero"/)
			assert.match(html, /class="external" src="https:\/\/cdn\.example\.com\/kept\.png"/)
			assert.match(html, /class="photo" src="\/uploads\/logo\.png"/)
			await fs.access(path.join(out_dir, 'uploads', 'hero shot.jpg'))
		} finally {
			await cleanup()
		}
	})

	test('rich-text and markdown fields reach blocks as HTML', async () => {
		const { result, html, cleanup } = await build({
			fields: [
				'- name: body',
				'  type: rich-text',
				'- name: intro',
				'  type: rich-text',
				'- name: notes',
				'  type: markdown',
				'- name: items',
				'  type: repeater',
				'  subfields:',
				'    - name: text',
				'      type: rich-text',
				''
			].join('\n'),
			content: [
				'body:',
				'  type: doc',
				'  content:',
				'    - type: heading',
				'      attrs: { level: 2 }',
				'      content: [{ type: text, text: Title }]',
				'    - type: paragraph',
				'      content:',
				'        - type: text',
				'          text: a < b',
				'          marks: [{ type: bold }, { type: link, attrs: { href: "https://example.com/?a=1&b=2" } }]',
				'        - type: hardBreak',
				'intro: "Plain *markdown*"',
				'notes: "**md** text"',
				'items:',
				'  - text: { type: doc, content: [{ type: paragraph, content: [{ type: text, text: Nested }] }] }',
				''
			].join('\n'),
			component: [
				'<script>let { body, intro, notes, items } = $props()</script>',
				'<div class="body">{@html body}</div>',
				'<div class="intro">{@html intro}</div>',
				'<div class="notes">{@html notes}</div>',
				'{#each items as item}<div class="item">{@html item.text}</div>{/each}',
				''
			].join('\n')
		})
		try {
			assert.equal(result.code, 0, result.output)
			assert.doesNotMatch(html, /\[object Object\]/)
			assert.ok(html.includes(
				'<h2>Title</h2><p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/?a=1&amp;b=2"><strong>a &lt; b</strong></a><br></p>'
			), html)
			assert.match(html, /<p>Plain <em>markdown<\/em><\/p>/)
			assert.match(html, /<p><strong>md<\/strong> text<\/p>/)
			assert.match(html, /<div class="item"><!---->?<p>Nested<\/p>/)
		} finally {
			await cleanup()
		}
	})

	test('fields without a value get the empty value server publish passes', async () => {
		const { result, html, cleanup } = await build({
			fields: [
				'- name: headline',
				'  type: text',
				'- name: image',
				'  type: image',
				'- name: cta',
				'  type: link',
				'- name: meta',
				'  type: group',
				'  subfields:',
				'    - name: note',
				'      type: text',
				'- name: cards',
				'  type: repeater',
				'  subfields:',
				'    - name: title',
				'      type: text',
				'    - name: photo',
				'      type: image',
				''
			].join('\n'),
			content: 'headline: Hello\ncards:\n  - title: One\n',
			component: [
				'<h1>{headline}</h1>',
				'<img class="image" src={image.url} alt={image.alt}>',
				'<a href={cta.url || "#"}>{cta.label}</a>',
				'<p class="note">[{meta.note ?? "none"}]</p>',
				'{#each cards as card}<img class="card" src={card.photo.url} alt={card.title}>{/each}',
				''
			].join('\n')
		})
		try {
			assert.equal(result.code, 0, result.output)
			assert.match(html, /<h1>Hello<\/h1>/)
			assert.match(html, /<img class="image" src="" alt=""\/?>/)
			assert.match(html, /<a href="#"><\/a>/)
			assert.match(html, /<p class="note">\[none\]<\/p>/)
			assert.match(html, /<img class="card" src="" alt="One"\/?>/)
		} finally {
			await cleanup()
		}
	})

	test('sections sit in header/main/footer zones and wrapper divs', async () => {
		const { result, html, cleanup } = await build({
			fields: '- name: headline\n  type: text\n',
			content: 'headline: Hello\n',
			component: '<script>let { headline } = $props()</script>\n<h1>{headline}</h1>\n',
			async setup(site_dir) {
				await write_file(site_dir, 'blocks/nav/component.svelte', '<nav>Nav</nav>\n')
				await write_file(site_dir, 'page-types/default/layout.yaml', 'header:\n  - _id: navsection00001\n    block: nav\n')
			}
		})
		try {
			assert.equal(result.code, 0, result.output)
			assert.match(html, /<body id="page">/)
			assert.match(html, /<header><div data-section="navsection00001" id="section-navsection00001" data-symbol="nav"><nav>Nav<\/nav>/)
			assert.match(html, /<main><div data-section="section0000001" id="section-section0000001" data-symbol="hero"><h1>Hello<\/h1>/)
			assert.doesNotMatch(html, /<footer>/, 'an unused footer zone is left out')
		} finally {
			await cleanup()
		}
	})

	test('blocks with a script ship a client bundle and are hydrated', async () => {
		const { result, html, out_dir, cleanup } = await build({
			fields: '- name: headline\n  type: text\n',
			content: 'headline: "</script><b>"\n',
			component: [
				'<script>',
				"import { fade } from 'svelte/transition'",
				'let open = $state(false)',
				'</script>',
				'<h1>{headline}</h1><button onclick={() => (open = !open)}>Toggle</button>',
				'{#if open}<p transition:fade>Open</p>{/if}',
				''
			].join('\n'),
			async setup(site_dir) {
				await write_file(site_dir, 'blocks/nav/component.svelte', '<nav>Nav</nav>\n')
				await write_file(site_dir, 'page-types/default/layout.yaml', 'header:\n  - block: nav\n')
			}
		})
		try {
			assert.equal(result.code, 0, result.output)
			const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)
			assert.ok(script, 'page has no hydration script')
			assert.match(script[1], /import\('\/_symbols\/hero\.js'\)\.then\(\(\{ default: App, hydrate \}\) => \{hydrate\(App, \{ target: document\.querySelector\('#section-section0000001'\), props: \{"headline":"\\u003c\/script>\\u003cb>"\} \}\);\}\)/)
			assert.doesNotMatch(script[1], /nav\.js/, 'a block without a script must not ship JS')
			const bundle = await fs.readFile(path.join(out_dir, '_symbols', 'hero.js'), 'utf8')
			assert.match(bundle, /export\s*\{[^}]*\bhydrate\b[^}]*\}/)
			await assert.rejects(fs.access(path.join(out_dir, '_symbols', 'nav.js')))
		} finally {
			await cleanup()
		}
	})
})
