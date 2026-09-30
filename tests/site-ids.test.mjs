import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'
import { find_duplicate_site_ids, find_copied_entity_ids, strip_entity_ids } from '../dist/utils/site-ids.js'
import { run_cli, make_workspace } from './helpers/run-cli.mjs'

async function write(root, rel, content) {
	await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
	await fs.writeFile(path.join(root, rel), content)
}

async function site(root, name, site_id) {
	const dir = path.join(root, 'sites', name)
	await write(dir, 'site.yaml', `name: ${name}\n${site_id ? `site_id: ${site_id}\n` : ''}`)
	await write(dir, 'blocks/hero/config.yaml', '_id: heroblock000001\nname: Hero\n')
	await write(dir, 'pages/index.yaml', 'name: Home\npage_type: default\nsections:\n  - _id: section0000001a\n    block: hero\n    content:\n      headline: Hi\n')
	return dir
}

test('a backup copy inside sites/ is reported as a duplicate site_id', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-ids-'))
	const original = await site(root, 'coffee', 'coffeesite00001')
	const backup = await site(root, 'coffee.bak', 'coffeesite00001')
	const other = await site(root, 'yoga', 'yogasite0000001')
	const duplicates = await find_duplicate_site_ids([original, backup, other])
	assert.deepEqual([...duplicates.keys()], ['coffeesite00001'])
	assert.deepEqual(duplicates.get('coffeesite00001'), [original, backup])
})

test('ids copied from another site are found and stripped without breaking list items', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-ids-'))
	const source = await site(root, 'coffee', 'coffeesite00001')
	const copy = await site(root, 'plumber')
	const copied = await find_copied_entity_ids(copy, [source])
	assert.deepEqual(copied.map(c => c.id).sort(), ['heroblock000001', 'section0000001a'])
	assert.equal(await strip_entity_ids(copy), 2)
	const page = yaml.load(await fs.readFile(path.join(copy, 'pages/index.yaml'), 'utf8'))
	assert.deepEqual(page.sections, [{ block: 'hero', content: { headline: 'Hi' } }])
	assert.deepEqual(await find_copied_entity_ids(copy, [source]), [])
})

test('primo new without a terminal creates the site and returns instead of starting the CMS', async t => {
	const workspace = await make_workspace(); t.after(workspace.cleanup)
	const options = { cwd: workspace.work, home: workspace.home, timeout_ms: 20000 }
	assert.equal((await run_cli(['init', '--no-mcp', 'ws'], options)).code, 0)
	const result = await run_cli(['new', 'demo'], { ...options, cwd: path.join(workspace.work, 'ws') })
	assert.equal(result.code, 0, result.output)
	assert.match(result.output, /primo dev/)
	await fs.access(path.join(workspace.work, 'ws/sites/demo/site.yaml'))
})

test('validate rejects repeater children under fields: and checks every site from the workspace root', async t => {
	const workspace = await make_workspace(); t.after(workspace.cleanup)
	const options = { cwd: workspace.work, home: workspace.home, timeout_ms: 20000 }
	await run_cli(['init', '--no-mcp', 'ws'], options)
	const ws = path.join(workspace.work, 'ws')
	for (const name of ['a', 'b']) await run_cli(['new', name, '--skip-dev'], { ...options, cwd: ws })
	const clean = await run_cli(['validate'], { ...options, cwd: ws })
	assert.equal(clean.code, 0, clean.output)
	assert.match(clean.output, /sites\/a/)
	assert.match(clean.output, /sites\/b/)
	await write(ws, 'sites/b/site/fields.yaml', '- name: nav\n  label: Nav\n  type: repeater\n  fields:\n    - name: label\n      label: Label\n      type: text\n')
	const broken = await run_cli(['validate'], { ...options, cwd: ws })
	assert.notEqual(broken.code, 0)
	assert.match(broken.output, /go under "subfields:"/)
})
