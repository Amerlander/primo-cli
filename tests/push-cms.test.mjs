import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { make_workspace, run_cli } from './helpers/run-cli.mjs'

// Coordinated CMS/CLI contract test. Point at a freshly built CMS binary:
// PRIMO_TEST_CMS_BINARY=/path/to/primo node --test tests/push-cms.test.mjs
test('real CMS: fresh push, pull, client edit, rejected push, backed-up force, repeat push', {
	skip: !process.env.PRIMO_TEST_CMS_BINARY, timeout: 90000
}, async t => {
	const workspace = await make_workspace()
	const reservation = net.createServer()
	await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
	const port = reservation.address().port
	await new Promise(resolve => reservation.close(resolve))
	const server = `http://127.0.0.1:${port}`
	let logs = ''
	const process = spawn(globalThis.process.env.PRIMO_TEST_CMS_BINARY, ['serve','--http',`127.0.0.1:${port}`,'--dir',path.join(workspace.root,'pb_data')], {
		env: {...globalThis.process.env, PRIMO_DEV_MODE:'1', PRIMO_AUTHOR_MODE:'both', PRIMO_ENABLE_USAGE_STATS:'false'},
		stdio:['ignore','pipe','pipe']
	})
	process.stdout.on('data', data => { logs += data })
	process.stderr.on('data', data => { logs += data })
	t.after(async () => {
		if (process.exitCode === null) {
			const stopped = new Promise(resolve => process.once('close',resolve))
			process.kill('SIGTERM')
			await stopped
		}
		await workspace.cleanup()
	})
	let ready = false
	for (let attempt = 0; attempt < 100; attempt++) {
		try { if ((await fetch(`${server}/api/health`)).ok) { ready = true; break } } catch {}
		if (process.exitCode !== null) break
		await delay(100)
	}
	assert.ok(ready,`CMS failed to start:\n${logs}`)
	let id = 'safepushtest001'
	let dir = path.join(workspace.work,'sites/demo')
	const files = {
		'server.yaml':`server: ${server}\n`,
		'sites/demo/site.yaml':`name: Demo\nsite_id: ${id}\nserver: ${server}\n`,
		'sites/demo/blocks/hero/config.yaml':'name: Hero\n',
		'sites/demo/blocks/hero/component.svelte':'<h1>{heading}</h1>\n<style>h1 { color: red; }</style>\n',
		'sites/demo/blocks/hero/fields.yaml':'- name: heading\n  type: text\n',
		'sites/demo/page-types/default/config.yaml':'name: Default\nallowed_blocks: [hero]\n',
		'sites/demo/pages/index.yaml':'name: Home\npage_type: Default\nsections:\n  - block: hero\n    content:\n      heading: Original headline\n'
	}
	for (const [name,contents] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(workspace.work,name)),{recursive:true})
		await fs.writeFile(path.join(workspace.work,name),contents)
	}
	const cli = args => run_cli(args,{cwd:workspace.work,home:workspace.home,timeout_ms:30000})
	const initial = await cli(['push'])
	assert.equal(initial.code,0,initial.output)
	const auth = await fetch(`${server}/api/primo/dev-auth`,{method:'POST'}).then(response => response.json())
	assert.ok(auth.token)
	const headers = {Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'}
	// Exercise a whole-server workspace with two sites and a shared library.
	const firstID = id
	id = 'safepushtest002'
	dir = path.join(workspace.work,'sites/second')
	for (const [name,contents] of Object.entries(files)) {
		if (!name.startsWith('sites/demo/')) continue
		const destination = path.join(workspace.work,name.replace('sites/demo/','sites/second/'))
		await fs.mkdir(path.dirname(destination),{recursive:true})
		await fs.writeFile(destination,contents.replaceAll(firstID,id).replace('name: Demo','name: Second'))
	}
	await fs.mkdir(path.join(workspace.work,'library/shared/banner'),{recursive:true})
	await fs.writeFile(path.join(workspace.work,'library/groups.yaml'),'- name: Shared\n  folder: shared\n')
	await fs.writeFile(path.join(workspace.work,'library/shared/banner/config.yaml'),'name: Banner\n')
	await fs.writeFile(path.join(workspace.work,'library/shared/banner/component.svelte'),'<p>Shared banner</p>')
	const seeded = await cli(['push','--token',auth.token])
	assert.equal(seeded.code,0,seeded.output)
	const pull = await cli(['pull',server,workspace.work,'--token',auth.token])
	assert.equal(pull.code,0,pull.output)
	const entries = await fetch(`${server}/api/collections/page_section_entries/records?filter=${encodeURIComponent(`section.page.site = '${id}'`)}`,{headers}).then(response => response.json())
	assert.equal(entries.items.length,1)
	const entryID = entries.items[0].id
	const edit = await fetch(`${server}/api/collections/page_section_entries/records/${entryID}`,{method:'PATCH',headers,body:JSON.stringify({value:'Client edit after pull'})})
	assert.equal(edit.status,200,await edit.text())
	const component = path.join(dir,'blocks/hero/component.svelte')
	const original = await fs.readFile(component,'utf8')
	const local = original.replace('red','hotpink')
	assert.notEqual(original,local)
	await fs.writeFile(component,local)
	const firstBefore = await fetch(`${server}/api/primo/push-state/${firstID}`,{headers}).then(response => response.json())
	const blocked = await cli(['push','--token',auth.token])
	assert.equal(blocked.code,1,blocked.output)
	assert.match(blocked.output,/changed on the server/)
	const firstAfter = await fetch(`${server}/api/primo/push-state/${firstID}`,{headers}).then(response => response.json())
	assert.equal(firstAfter.revision,firstBefore.revision,'preflight must prevent uploading the earlier, unaffected site')
	const latest = await fetch(`${server}/api/collections/page_section_entries/records/${entryID}`,{headers}).then(response => response.json())
	assert.equal(latest.value,'Client edit after pull')
	assert.equal(await fs.readFile(component,'utf8'),local)
	const forced = await cli(['push','--token',auth.token,'--force','--yes'])
	assert.equal(forced.code,0,forced.output)
	const backups = await fs.readdir(path.join(dir,'.primo/backups',id))
	assert.equal(backups.length,1)
	assert.equal((await fs.readdir(path.join(workspace.work,'.primo/backups/library'))).length,1)
	const symbols = await fetch(`${server}/api/collections/site_symbols/records?filter=${encodeURIComponent(`site = '${id}'`)}`,{headers}).then(response => response.json())
	assert.match(symbols.items[0].css,/hotpink/)
	const repeat = await cli(['push','--token',auth.token])
	assert.equal(repeat.code,0,repeat.output)
})
