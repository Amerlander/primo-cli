import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { run_cli, make_workspace } from './helpers/run-cli.mjs'

test('shared navigation computes active per page without changing authored content', async () => {
	const workspace = await make_workspace()
	const site = path.join(workspace.work, 'site')
	const output = path.join(workspace.work, 'out')
	async function write(relative, contents) {
		const file = path.join(site, relative)
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, contents)
	}
	try {
		await write('site.yaml', 'name: Navigation\nsite_id: fixture00000001\ngroup: default\n')
		await write('site/head.svelte', '<title>Navigation</title>\n')
		await write('site/fields.yaml', '- name: nav\n  type: repeater\n')
		const navigation = `nav:
  - group:
      link: { page: home00000000001, label: Home, active: false }
  - group:
      link: { page: about0000000001, label: About, active: true }
  - group:
      link: { page: child0000000001, label: Child }
  - group:
      link: { url: /about, label: URL, active: true }
  - group:
      link: { url: 'https://example.com', label: External, active: true }
  - group:
      link: { url: /about, active: true }
  - group:
      link: { url: 'https://unlabeled.example.com', active: true }
  - group:
      link: { page: deleted00000001, label: Deleted, active: true }
  - group:
      link: { url: '', label: Empty, active: true }
`
		await write('site/content.yaml', navigation)
		await write('blocks/nav/config.yaml', 'name: Navigation\n')
		await write('blocks/nav/fields.yaml', '- name: nav\n  type: site-field\n  config:\n    field: nav\n')
		await write('blocks/nav/component.svelte', `<script>let { nav = [] } = $props()</script>
<nav>{#each nav as item}<a href={item.group.link.url} class:active={item.group.link.active}>{item.group.link.label || item.group.link.url}</a>{/each}</nav>
`)
		await write('page-types/default/config.yaml', 'name: Default\n')
		await write('page-types/default/fields.yaml', '[]\n')
		await write('page-types/default/layout.yaml', 'header:\n  - block: nav\nfooter:\n  - block: nav\n')
		for (const [file, id] of [['index', 'home00000000001'], ['about/index', 'about0000000001'], ['about/child', 'child0000000001']]) {
			await write(`pages/${file}.yaml`, `_id: ${id}\nname: ${file}\npage_type: default\nfields: {}\nsections:\n  - block: nav\n`)
		}

		const result = await run_cli(['build', '-d', site, '-o', output], { cwd: workspace.work, home: workspace.home })
		assert.equal(result.code, 0, result.output)
		for (const [file, current] of [['index.html', 'Home'], ['about/index.html', 'About'], ['about/child/index.html', 'Child']]) {
			const html = await fs.readFile(path.join(output, file), 'utf8')
			assert.match(html, /<a\b[^>]*href="\/about"[^>]*>\/about<\/a>/, file)
			assert.match(html, /<a\b[^>]*href="https:\/\/unlabeled\.example\.com"[^>]*>https:\/\/unlabeled\.example\.com<\/a>/, file)
			const activeLabels = [...html.matchAll(/<a\b[^>]*class="[^"]*\bactive\b[^"]*"[^>]*>([^<]*)<\/a>/g)].map(match => match[1])
			// Header, page section, and footer all resolve the same shared content.
			assert.deepEqual(activeLabels, [current, current, current], file)
		}
		assert.equal(await fs.readFile(path.join(site, 'site/content.yaml'), 'utf8'), navigation)
	} finally {
		await workspace.cleanup()
	}
})
