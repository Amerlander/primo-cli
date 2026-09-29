import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { read_dev_runtime, resolve_dev_server, runtime_is_running } from '../dist/utils/dev-runtime.js'
import { select_dev_port } from '../dist/utils/dev-port.js'
import { CLI_ENTRY, make_workspace, run_cli } from './helpers/run-cli.mjs'

async function fixture(t) {
 const workspace = await make_workspace(); t.after(workspace.cleanup)
 const port = await select_dev_port({ port: 42000, explicit: false })
 const runtime = { version: 1, workspace: await fs.realpath(workspace.work), port, pid: process.pid, instance: 'test-session' }
 await fs.mkdir(path.join(workspace.work, '.primo'), { recursive: true })
 await fs.mkdir(path.join(workspace.work, 'sites/demo'), { recursive: true })
 await fs.writeFile(path.join(workspace.work, 'server.yaml'), 'port: 2\n')
 await fs.writeFile(path.join(workspace.work, 'sites/demo/site.yaml'), 'name: Demo\nsite_id: aaaaaaaaaaaaaaa\n')
 const file = path.join(workspace.work, '.primo/dev-server.json')
 await fs.writeFile(file, JSON.stringify(runtime))
 const requests = []
 const api = http.createServer((req, res) => {
  requests.push(req.url)
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/api/health') return res.end('{}')
  if (req.url === '/api/primo/dev-auth') return res.end('{"token":"test"}')
  res.writeHead(404); res.end('{}')
 })
 const control = http.createServer((req, res) => { requests.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/reload' ? { loaded: 1 } : runtime)) })
 for (const [server, chosen] of [[api, port], [control, port + 1]]) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(chosen, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
 }
 return { workspace, runtime, file, requests }
}

test('CLI status and preview discover runtime port ahead of server.yaml', async t => {
 const { workspace, runtime, requests } = await fixture(t)
 const options = { cwd: workspace.work, home: workspace.home }
 const result = await run_cli(['status', '--json'], options)
 assert.equal(result.code, 0, result.output)
 const status = JSON.parse(result.stdout)
 assert.equal(status.port, runtime.port)
 assert.equal(status.running, true)
 const preview = await run_cli(['preview', '--dir', 'sites/demo'], options)
 assert.notEqual(preview.code, 0)
 assert.ok(requests.includes('/api/collections/sites/records/aaaaaaaaaaaaaaa'), preview.output)
 // Reaching the selected server's missing-site guard proves discovery, without compiling.
})

test('stale session identity never falls through to another healthy server', async t => {
 const { workspace, runtime, file, requests } = await fixture(t)
 await fs.writeFile(file, JSON.stringify({ ...runtime, instance: 'old-session' }))
 const resolved = await resolve_dev_server(workspace.work, 3000)
 assert.equal(resolved.port, runtime.port)
 assert.equal(resolved.running, false)
 assert.ok(requests.every(url => url === '/__primo/runtime'))
 await fs.writeFile(file, JSON.stringify({ ...runtime, pid: 2147483647 }))
 assert.equal(await runtime_is_running(await read_dev_runtime(workspace.work)), false)
 const result = await run_cli(['preview', '--dir', 'sites/demo'], { cwd: workspace.work, home: workspace.home })
 assert.notEqual(result.code, 0)
 assert.ok(requests.every(url => url === '/__primo/runtime'))
})

test('duplicate workspace dev and add refuse a live session before changing site IDs', async t => {
 const { workspace, runtime } = await fixture(t)
 const options = { cwd: workspace.work, home: workspace.home }
 const result = await run_cli(['dev', '--port', String(runtime.port + 2)], options)
 assert.notEqual(result.code, 0)
 assert.match(result.output, /already has a Primo server/)
 const add = await run_cli(['add', 'demo', '--port', String(runtime.port + 2)], options)
 assert.notEqual(add.code, 0)
 assert.match(add.output, /running or starting/)
})

async function start_dev(t, workspace, args = []) {
 const binary = path.join(workspace.root, 'fake-cms.mjs')
 await fs.writeFile(binary, `#!${process.execPath}\nimport http from 'node:http';\nconst address = process.argv[process.argv.indexOf('--http') + 1];\nhttp.createServer((req,res) => { res.setHeader('Content-Type','application/json'); res.end(req.url === '/api/primo/dev-auth' ? '{"token":"test"}' : '{"items":[]}'); }).listen(Number(address.split(':').pop()), '127.0.0.1');\n`)
 await fs.chmod(binary, 0o755)
 const child = spawn(process.execPath, [CLI_ENTRY, 'dev', ...args], { cwd: workspace.work, env: { ...process.env, HOME: workspace.home, PRIMO_BINARY: binary } })
 let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
 t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } })
 const deadline = Date.now() + 15000
 while (Date.now() < deadline) {
  if (child.exitCode !== null) throw new Error(output)
  const runtime = await read_dev_runtime(workspace.work)
  if (runtime && await runtime_is_running(runtime)) return { child, runtime, output: () => output }
  await new Promise(resolve => setTimeout(resolve, 100))
 }
 throw new Error(`Server did not become ready: ${output}`)
}

async function empty_workspace(t, config = '{}\n') {
 const workspace = await make_workspace(); t.after(workspace.cleanup)
 await fs.writeFile(path.join(workspace.work, 'server.yaml'), config)
 await fs.mkdir(path.join(workspace.work, 'sites'))
 return workspace
}

test('two CLI dev sessions use distinct port pairs, retain config, and clean up on shutdown', async t => {
 const first = await empty_workspace(t)
 const second = await empty_workspace(t)
 const a = await start_dev(t, first)
 const b = await start_dev(t, second)
 assert.ok(b.runtime.port >= a.runtime.port + 2)
 assert.match(b.output(), /Using http:\/\/localhost:/)
 for (const workspace of [first, second]) assert.equal(await fs.readFile(path.join(workspace.work, 'server.yaml'), 'utf8'), '{}\n')
 const status = await run_cli(['status', '--json'], { cwd: second.work, home: second.home })
 assert.equal(JSON.parse(status.stdout).port, b.runtime.port)
 b.child.kill('SIGTERM'); await once(b.child, 'exit')
 assert.equal(await read_dev_runtime(second.work), null)
})

test('new and local pull discovery use the runtime even when config points elsewhere', async t => {
 const { workspace, requests } = await fixture(t)
 const options = { cwd: workspace.work, home: workspace.home }
 const created = await run_cli(['new', 'second', '--skip-dev'], options)
 assert.equal(created.code, 0, created.output)
 assert.ok(requests.includes('/reload'), created.output)
 for (const args of [['pull', '', path.join(workspace.root, 'pulled')], ['library', 'pull']]) {
  await run_cli(args, options)
 }
 assert.ok(requests.includes('/api/collections/sites/records?perPage=200'), requests.join('\n'))
 assert.ok(requests.includes('/api/primo/export-library'))
})

test('server.yaml port controls actual startup without a CLI flag', async t => {
 const port = await select_dev_port({ port: 45000, explicit: false })
 const workspace = await empty_workspace(t, `port: ${port}\n`)
 const session = await start_dev(t, workspace)
 assert.equal(session.runtime.port, port)
 assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, true)
})

test('CLI --port actually controls the server despite a different configured port', async t => {
 const workspace = await empty_workspace(t, 'port: 2\n')
 const port = await select_dev_port({ port: 44000, explicit: false })
 const session = await start_dev(t, workspace, ['--port', String(port)])
 assert.equal(session.runtime.port, port)
 assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).ok, true)
 assert.equal(await fs.readFile(path.join(workspace.work, 'server.yaml'), 'utf8'), 'port: 2\n')
})
