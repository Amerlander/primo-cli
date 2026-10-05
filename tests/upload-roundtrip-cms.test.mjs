import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { import_site_files } from '../dist/commands/dev.js'
import { make_workspace, run_cli } from './helpers/run-cli.mjs'

// Runs the actual dev import and hosted push against independent databases.
test('real CMS: dev → hosted push → dev keeps uploads portable', {
	skip: !process.env.PRIMO_TEST_CMS_BINARY, timeout: 90000
}, async t => {
	const workspace = await make_workspace()
	t.after(workspace.cleanup)
	const start = async name => {
		const reservation = net.createServer()
		await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
		const port = reservation.address().port
		await new Promise(resolve => reservation.close(resolve))
		const url = `http://127.0.0.1:${port}`
		const child = spawn(process.env.PRIMO_TEST_CMS_BINARY, ['serve', '--http', `127.0.0.1:${port}`, '--dir', path.join(workspace.root, name)], {
			env: { ...process.env, PRIMO_DEV_MODE: '1', PRIMO_ENABLE_USAGE_STATS: 'false' }, stdio: ['ignore', 'pipe', 'pipe']
		})
		let logs = ''
		child.stdout.on('data', b => logs += b)
		child.stderr.on('data', b => logs += b)
		t.after(async () => {
			if (child.exitCode !== null) return
			const stopped = new Promise(resolve => child.once('close', resolve))
			child.kill('SIGTERM')
			await stopped
		})
		for (let i = 0; i < 100; i++) {
			try { if ((await fetch(`${url}/api/health`)).ok) return { url, port } } catch {}
			if (child.exitCode !== null) break
			await delay(100)
		}
		throw new Error(`CMS failed to start: ${logs}`)
	}
	const local = await start('local-db'), hosted = await start('hosted-db')
	const site = path.join(workspace.work, 'sites/demo')
	const id = 'uploadtestsite1'
	const config = { name: 'Demo', site_id: id }
	const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
	const files = {
		'server.yaml': `server: ${hosted.url}\n`,
		'sites/demo/site.yaml': `name: Demo\nsite_id: ${id}\nserver: ${hosted.url}\n`,
		'sites/demo/site/fields.yaml': '- name: favicon\n  type: image\n- name: og_default\n  type: image\n',
		'sites/demo/site/content.yaml': 'favicon:\n  upload: uploads/hero.png\nog_default:\n  upload: uploads/hero.png\n',
		'sites/demo/blocks/hero/config.yaml': 'name: Hero\n',
		'sites/demo/blocks/hero/component.svelte': '<img src={image.url} alt={image.alt} />\n',
		'sites/demo/blocks/hero/fields.yaml': '- name: image\n  type: image\n',
		'sites/demo/page-types/default/config.yaml': 'name: Default\nallowed_blocks: [hero]\n',
		'sites/demo/pages/index.yaml': 'name: Home\npage_type: Default\nsections:\n  - block: hero\n    content:\n      image:\n        upload: uploads/hero.png\n        alt: A hero\n',
		'sites/demo/uploads/hero.png': image,
		'sites/demo/uploads/.manifest.json': '{}\n'
	}
	for (const [name, contents] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(workspace.work, name)), { recursive: true })
		await fs.writeFile(path.join(workspace.work, name), contents)
	}
	const assert_portable = async () => {
		const content = load(await fs.readFile(path.join(site, 'site/content.yaml'), 'utf8'))
		assert.equal(content.favicon.upload, 'uploads/hero.png')
		assert.equal(content.og_default.upload, 'uploads/hero.png')
		const page = load(await fs.readFile(path.join(site, 'pages/index.yaml'), 'utf8'))
		assert.equal(page.sections[0].content.image.upload, 'uploads/hero.png')
		assert.deepEqual((await fs.readdir(path.join(site, 'uploads'))).sort(), ['.manifest.json', 'hero.png'])
		assert.equal(await fs.readFile(path.join(site, 'uploads/.manifest.json'), 'utf8'), '{}\n')
	}
	assert.equal((await import_site_files(site, local.url, config, local.port, {}, true, workspace.work)).ok, true)
	await assert_portable()
	let hosted_token
	for (let i = 0; i < 2; i++) {
		const pushed = await run_cli(hosted_token ? ['push', '--token', hosted_token] : ['push'], { cwd: workspace.work, home: workspace.home })
		assert.equal(pushed.code, 0, pushed.output)
		hosted_token = (await fetch(`${hosted.url}/api/primo/dev-auth`, { method: 'POST' }).then(r => r.json())).token
		await assert_portable()
		assert.equal((await import_site_files(site, local.url, config, local.port, {}, false, workspace.work)).ok, true)
		await assert_portable()
	}
	const upload_for = async server => {
		const auth = await fetch(`${server}/api/primo/dev-auth`, { method: 'POST' }).then(r => r.json())
		const headers = { Authorization: `Bearer ${auth.token}` }
		const records = await fetch(`${server}/api/collections/site_uploads/records`, { headers }).then(r => r.json())
		assert.equal(records.items.length, 1)
		const upload = records.items[0]
		for (const collection of ['site_entries', 'page_section_entries']) {
			const entries = await fetch(`${server}/api/collections/${collection}/records`, { headers }).then(r => r.json())
			assert.ok(entries.items.some(entry => JSON.stringify(entry.value).includes(upload.id)))
		}
		const file = await fetch(`${server}/api/files/site_uploads/${upload.id}/${upload.file}`)
		assert.equal(file.status, 200)
		assert.deepEqual(Buffer.from(await file.arrayBuffer()), image)
		return upload
	}
	assert.notEqual((await upload_for(local.url)).id, (await upload_for(hosted.url)).id)
})
