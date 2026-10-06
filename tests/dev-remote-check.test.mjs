import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { save_baseline } from '../dist/utils/push-guard.js'
import { start_mock_server } from './helpers/mock-server.mjs'
import { make_workspace } from './helpers/run-cli.mjs'

const revision = digit => 'v1:' + digit.repeat(64)
const module_url = new URL('../dist/utils/dev-remote-check.js', import.meta.url).href
const exec_file = promisify(execFile)

// Keep the auth store in a disposable HOME, as in the CLI tests.
async function check(workspace, sites, server, library = false, timeout = 5000) {
	const script = `import { check_dev_remote_changes } from ${JSON.stringify(module_url)};
		console.log(JSON.stringify(await check_dev_remote_changes(...JSON.parse(process.argv[1]))));`
	const { stdout } = await exec_file(process.execPath, ['--input-type=module', '-e', script,
		JSON.stringify([workspace.work, sites, server, library, timeout])], {
		env: { ...process.env, HOME: workspace.home, USERPROFILE: workspace.home }, timeout: 10000
	})
	return JSON.parse(stdout)
}

async function fixture(t) {
	const workspace = await make_workspace()
	const server = await start_mock_server({ sites: [{ id: 'demo', name: 'Demo' }] })
	t.after(async () => { await server.close(); await workspace.cleanup() })
	const dir = path.join(workspace.work, 'sites/demo')
	await fs.mkdir(dir, { recursive: true })
	await fs.mkdir(path.join(workspace.work, 'library'))
	const sites = [{ dir, config: { site_id: 'demo', name: 'Demo', server: server.url } }]
	await save_baseline(dir, server.url, 'demo', revision('a'))
	await save_baseline(workspace.work, server.url, 'library', revision('a'))
	await workspace.write_token(server.url, 'cached-token')
	return { workspace, server, dir, sites }
}

test('current sites and library are quiet; changed targets warn without altering files or baselines', async t => {
	const { workspace, server, dir, sites } = await fixture(t)
	await fs.writeFile(path.join(dir, 'content.yaml'), 'local edits\n')
	const baseline = await fs.readFile(path.join(dir, '.primo/sync-state.json'), 'utf8')
	const library_baseline = await fs.readFile(path.join(workspace.work, '.primo/sync-state.json'), 'utf8')
	assert.deepEqual(await check(workspace, sites, server.url + '/', true), [])
	server.revisions.demo = revision('b')
	server.revisions.library = revision('c')
	const notices = await check(workspace, sites, server.url, true)
	assert.equal(notices.length, 2)
	assert.match(notices[0], /Demo: changed on .* since the last sync/)
	assert.match(notices[1], /Shared library: changed on/)
	assert.equal(await fs.readFile(path.join(dir, 'content.yaml'), 'utf8'), 'local edits\n')
	assert.equal(await fs.readFile(path.join(dir, '.primo/sync-state.json'), 'utf8'), baseline)
	assert.equal(await fs.readFile(path.join(workspace.work, '.primo/sync-state.json'), 'utf8'), library_baseline)
	assert.ok(server.requests.every(r => r.method === 'GET' && r.authorization === 'Bearer cached-token'))
})

test('unknown history, deleted targets and new unpublished sites are distinguished', async t => {
	const { workspace, server, dir, sites } = await fixture(t)
	server.revisions.demo = 'absent'
	assert.match((await check(workspace, sites))[0], /changed on .*or was deleted/)
	await save_baseline(dir, server.url, 'demo', null)
	assert.deepEqual(await check(workspace, sites), [])
	server.revisions.demo = revision('a')
	await save_baseline(dir, 'https://another-server.example', 'demo', revision('a'))
	assert.match((await check(workspace, sites))[0], /no saved sync history.*freshness is unknown/)
})

test('target selection follows push defaults, includes inferred library, and skips unlinked workspaces', async t => {
	const { workspace, server, sites } = await fixture(t)
	assert.deepEqual(await check(workspace, sites.map(site => ({ ...site, config: { ...site.config, server: undefined } }))), [])
	assert.equal(server.requests.length, 0)
	const conflicting = sites.map(site => ({ ...site, config: { ...site.config, server: 'https://unused.example' } }))
	assert.deepEqual(await check(workspace, conflicting, server.url, true), [])
	assert.equal(server.matching('/api/primo/push-state/demo').length, 1)
	assert.equal(server.matching('/api/primo/push-state/library').length, 1)
	server.requests.length = 0
	assert.deepEqual(await check(workspace, sites, undefined, true), [])
	assert.equal(server.matching('/api/primo/push-state/library').length, 1)
	server.requests.length = 0
	await check(workspace, sites)
	assert.equal(server.matching('/api/primo/push-state/library').length, 0)
})

async function listener(t, handler) {
	const server = http.createServer(handler)
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
	return `http://127.0.0.1:${server.address().port}`
}

test('unsupported, unauthenticated and invalid responses become notices rather than startup errors', async t => {
	const { workspace, sites } = await fixture(t)
	for (const [status, body, expected] of [
		[404, {}, /Update the CMS/],
		[401, { message: 'Authentication required; run primo login.' }, /Authentication required/],
		[200, { protocol: 1, exists: true, revision: 'invalid' }, /invalid push revision/]
	]) {
		const server = await listener(t, (req, res) => { res.writeHead(status); res.end(JSON.stringify(body)) })
		const notices = await check(workspace, sites, server)
		assert.equal(notices.length, 1)
		assert.match(notices[0], /could not check.*freshness is unknown/)
		assert.match(notices[0], expected)
	}
})

test('unreachable servers report unknown freshness without losing the baseline', async t => {
	const { workspace, server, dir, sites } = await fixture(t)
	const baseline = await fs.readFile(path.join(dir, '.primo/sync-state.json'), 'utf8')
	await server.close()
	assert.match((await check(workspace, sites))[0], /could not check.*freshness is unknown/)
	assert.equal(await fs.readFile(path.join(dir, '.primo/sync-state.json'), 'utf8'), baseline)
})

test('repeated authentication failures are summarized for the workspace and library', async t => {
	const { workspace, sites } = await fixture(t)
	const requests = []
	const server = await listener(t, (req, res) => {
		requests.push({ method: req.method, authorization: req.headers.authorization })
		res.writeHead(401); res.end(JSON.stringify({ message: 'Authentication required.' }))
	})
	await workspace.write_token(server, 'cached-token')
	const many = Array.from({ length: 77 }, (_, i) => ({ ...sites[0], config: { ...sites[0].config, site_id: `site-${i}` } }))
	const notices = await check(workspace, many, server, true)
	assert.deepEqual(notices, [
		`${server}: could not check 77 sites and the shared library (Authentication required.). Server freshness is unknown.`
	])
	assert.equal(requests.length, 78)
	assert.ok(requests.every(req => req.method === 'GET' && req.authorization === 'Bearer cached-token'))
})

test('failure groups preserve distinct reasons and actionable site notices', async t => {
	const { workspace, sites, dir } = await fixture(t)
	const server = await listener(t, (req, res) => {
		const id = req.url.split('/').pop()
		if (id.startsWith('auth-')) {
			res.writeHead(401); res.end(JSON.stringify({ message: 'Authentication required.' }))
		} else if (id.startsWith('invalid-')) {
			res.writeHead(200); res.end(JSON.stringify({ protocol: 1, exists: true, revision: 'invalid' }))
		} else {
			res.writeHead(200); res.end(JSON.stringify({ protocol: 1, exists: id !== 'new',
				revision: id === 'new' ? 'absent' : revision(id === 'demo' ? 'b' : 'a') }))
		}
	})
	await save_baseline(dir, server, 'demo', revision('a'))
	const baseline = await fs.readFile(path.join(dir, '.primo/sync-state.json'), 'utf8')
	const many = ['demo', 'auth-1', 'unknown', 'invalid-1', 'auth-2', 'new', 'invalid-2'].map(id => ({
		...sites[0], config: { ...sites[0].config, site_id: id, name: id }
	}))
	const notices = await check(workspace, many, server)
	assert.equal(notices.length, 4)
	assert.match(notices[0], /^demo: changed on/)
	assert.equal(notices[1], `${server}: could not check 2 sites (Authentication required.). Server freshness is unknown.`)
	assert.match(notices[2], /^unknown: no saved sync history/)
	assert.match(notices[3], /could not check 2 sites .*invalid push revision/)
	assert.equal(await fs.readFile(path.join(dir, '.primo/sync-state.json'), 'utf8'), baseline)
})

test('the same failure on different servers stays separate', async t => {
	const { workspace, sites } = await fixture(t)
	const handler = (req, res) => {
		res.writeHead(401); res.end(JSON.stringify({ message: 'Authentication required.' }))
	}
	const servers = [await listener(t, handler), await listener(t, handler)]
	const many = servers.flatMap(server => [1, 2].map(i => ({ ...sites[0],
		config: { ...sites[0].config, site_id: `site-${i}`, server } })))
	assert.deepEqual(await check(workspace, many), servers.map(server =>
		`${server}: could not check 2 sites (Authentication required.). Server freshness is unknown.`))
})

test('stalled requests share a deadline for every site and the library', async t => {
	const { workspace, sites } = await fixture(t)
	const requests = []
	const server = await listener(t, (req, res) => {
		requests.push(req.url)
		// Stall the body after sending headers: the deadline must cover both.
		res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders()
	})
	const many = Array.from({ length: 5 }, (_, i) => ({ ...sites[0], config: { ...sites[0].config, site_id: `site-${i}` } }))
	const start = Date.now()
	const notices = await check(workspace, many, server, true, 500)
	assert.deepEqual(notices, [
		`${server}: could not check 5 sites and the shared library (check timed out). Server freshness is unknown.`
	])
	assert.equal(requests.length, 6)
	assert.ok(Date.now() - start < 2500, 'timeout should apply once, not once per target')
})
