import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { start_mock_server } from './helpers/mock-server.mjs'
import { make_workspace, run_cli } from './helpers/run-cli.mjs'
import { save_baseline } from '../dist/utils/push-guard.js'

const revision = digit => 'v1:' + digit.repeat(64)
const sites = ['alpha', 'beta', 'gamma'].map(name => ({id:name.padEnd(15, '0'), name, group:'', host:name}))
const files = {'site.yaml':'name: Example\n', 'pages/index.yaml':'name: Home\n', 'blocks/hero/component.svelte':'<h1>Original</h1>'}

async function fixture(t, options = {}) {
	const workspace = await make_workspace()
	const server = await start_mock_server({sites, export_files:files, ...options})
	t.after(async () => { await server.close(); await workspace.cleanup() })
	await fs.writeFile(path.join(workspace.work, 'server.yaml'), `server: ${server.url}\n`)
	for (const site of sites) {
		const dir = path.join(workspace.work, 'sites', site.name)
		await fs.mkdir(path.join(dir, 'pages'), {recursive:true})
		await fs.writeFile(path.join(dir, 'site.yaml'), `name: ${site.name}\nsite_id: ${site.id}\nserver: ${server.url}\n`)
		await fs.writeFile(path.join(dir, 'pages/index.yaml'), 'name: Developer local changes\n')
		await save_baseline(dir, server.url, site.id, revision('a'))
	}
	await fs.mkdir(path.join(workspace.work, 'library'), {recursive:true})
	await fs.writeFile(path.join(workspace.work, 'library/groups.yaml'), '[]\n')
	await save_baseline(workspace.work, server.url, 'library', revision('a'))
	return {workspace, server, run: (...args) => run_cli(['push','--token','test-token',...args],{cwd:workspace.work,home:workspace.home})}
}

test('whole-server preflight rejects a later stale site before any upload, including library', async t => {
	const {server,run,workspace} = await fixture(t)
	server.revisions[sites[1].id] = revision('b')
	const result = await run()
	assert.equal(result.code,1,result.output)
	assert.match(result.output,/beta: changed on the server/)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,0)
	assert.equal(server.matching('/api/primo/push-state/library').length,1)
	assert.equal(await fs.readFile(path.join(workspace.work,'sites/alpha/pages/index.yaml'),'utf8'),'name: Developer local changes\n')
})

test('a stale shared library blocks all sites, and --only excludes it', async t => {
	const {server,run} = await fixture(t)
	server.revisions.library = revision('b')
	const blocked = await run()
	assert.equal(blocked.code,1,blocked.output)
	assert.match(blocked.output,/library: changed on the server/)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,0)
	const allowed = await run('--only','alpha')
	assert.equal(allowed.code,0,allowed.output)
	assert.equal(server.matching('/api/primo/import-library').length,0)
})

test('force requires explicit confirmation, downloads backups and advances each baseline', async t => {
	const {server,run,workspace} = await fixture(t)
	server.revisions[sites[1].id] = revision('b')
	const declined = await run('--force')
	assert.equal(declined.code,1,declined.output)
	assert.match(declined.output,/--force --yes/)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,0)
	const forced = await run('--force','--yes')
	assert.equal(forced.code,0,forced.output)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,4)
	await fs.access(path.join(workspace.work,'sites/beta/.primo/backups',sites[1].id,'backup-1234.zip'))
	await fs.access(path.join(workspace.work,'.primo/backups/library/backup-1234.zip'))
	const normal = await run()
	assert.equal(normal.code,0,normal.output)
})

test('late conflict stops remaining uploads and reports completed and skipped targets', async t => {
	const {server,run} = await fixture(t,{on_request:({req,url,revisions}) => {
		if (req.method === 'POST' && url.pathname === `/api/primo/import/${sites[1].id}`) revisions[sites[1].id] = revision('f')
	}})
	const result = await run('--force','--yes')
	assert.equal(result.code,1,result.output)
	assert.match(result.output,/Completed: alpha/)
	assert.match(result.output,/Failed: beta/)
	assert.match(result.output,/Not attempted: gamma, library/)
	assert.equal(server.matching(`/api/primo/import/${sites[2].id}`).length,0)
	assert.equal(server.matching('/api/primo/import-library').length,0)
})

test('missing or wrong-server baseline refuses existing sites', async t => {
	const {server,run,workspace} = await fixture(t)
	const dir = path.join(workspace.work,'sites/alpha')
	await save_baseline(dir,server.url,sites[0].id,null)
	await save_baseline(dir,'https://different-server.example',sites[0].id,revision('a'))
	const result = await run('--only','alpha')
	assert.equal(result.code,1,result.output)
	assert.match(result.output,/no saved baseline/)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,0)
})

test('unsupported server cannot be bypassed with force', async t => {
	const {server,run} = await fixture(t,{unsupported_guard:true})
	const result = await run('--force','--yes')
	assert.equal(result.code,1,result.output)
	assert.match(result.output,/Update the CMS first/)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,0)
})

test('an existing site without auth never falls back to bootstrap, even with force', async t => {
	const {server,workspace} = await fixture(t)
	const result = await run_cli(['push','--only','alpha','--force','--yes'],{cwd:workspace.work,home:workspace.home})
	assert.equal(result.code,1,result.output)
	assert.match(result.output,/Authentication required to update an existing site/)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,0)
})

test('pull records export revisions and legacy pull invalidates an old baseline', async t => {
	for (const legacy_export of [false,true]) {
		const {server,workspace,run} = await fixture(t,{legacy_export})
		const pulled = await run_cli(['pull',server.url,workspace.work,'--token','test-token'],{cwd:workspace.work,home:workspace.home})
		assert.equal(pulled.code,0,pulled.output)
		await assert.rejects(fs.access(path.join(workspace.work,'library/groups.yaml')), 'pull must remove files absent from the exported library')
		const trash = await fs.readdir(path.join(workspace.work,'.primo/trash'))
		assert.ok(trash.some(name => name.startsWith('library-pull-')))
		const result = await run('--only','alpha')
		assert.equal(result.code,legacy_export ? 1 : 0,result.output)
		if (legacy_export) assert.match(result.output,/no saved baseline/)
	}
})

test('preview never overwrites the library or advances a stale baseline', async t => {
	const {server,run} = await fixture(t)
	server.revisions[sites[0].id] = revision('b')
	const preview = await run('--preview')
	assert.equal(preview.code,0,preview.output)
	assert.equal(server.matching('/api/primo/import-library').length,0)
	assert.equal(server.requests.filter(r => r.method === 'POST' && !r.path.endsWith('/preview')).length,0)
	const actual = await run()
	assert.equal(actual.code,1,actual.output)
	assert.match(actual.output,/alpha: changed on the server/)
})

test('a deleted server site is a conflict rather than silently recreated', async t => {
	const {server,run} = await fixture(t)
	server.revisions[sites[0].id] = 'absent'
	const result = await run('--only','alpha')
	assert.equal(result.code,1,result.output)
	assert.match(result.output,/changed on the server/)
	assert.equal(server.requests.filter(r => r.method === 'POST').length,0)
})
