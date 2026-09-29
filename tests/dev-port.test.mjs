import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs/promises'
import { requested_dev_port, select_dev_port, is_port_in_use } from '../dist/utils/dev-port.js'
import { read_server_config, write_server_config } from '../dist/utils/server-config.js'
import { make_workspace, run_cli } from './helpers/run-cli.mjs'

async function listener(t, port = 0) {
 const server = net.createServer(socket => socket.destroy())
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
 t.after(() => new Promise(resolve => server.close(resolve)))
 return server.address().port
}

test('explicit flag overrides config; malformed and out-of-range ports are rejected', () => {
 assert.deepEqual(requested_dev_port(), { port: 3000, explicit: false })
 assert.deepEqual(requested_dev_port(undefined, 3000), { port: 3000, explicit: true })
 assert.deepEqual(requested_dev_port('4000', 5000), { port: 4000, explicit: true })
 for (const value of ['3000oops', '1.5', '0', '-1', '65535', '', 'NaN']) assert.throws(() => requested_dev_port(value), /integer/)
})

test('fallback skips raw TCP listeners and finds two free ports', async t => {
 const occupied = await listener(t)
 assert.equal(await is_port_in_use(occupied), true)
 const selected = await select_dev_port({ port: occupied, explicit: false })
 assert.ok(selected > occupied)
 assert.equal(await is_port_in_use(selected), false)
 assert.equal(await is_port_in_use(selected + 1), false)
})

test('reload-only collision triggers fallback, configured ports require confirmation', async t => {
 const occupied = await listener(t)
 const port = occupied - 1
 await assert.rejects(select_dev_port({ port, explicit: true }), /--port/)
 let proposed
 const selected = await select_dev_port({ port, explicit: true, confirm: async next => { proposed = next; return true } })
 assert.equal(selected, proposed)
 assert.ok(selected > occupied)
 await assert.rejects(select_dev_port({ port, explicit: true, confirm: async () => false }), /cancelled/)
})

test('CLI noninteractive configured collision fails without modifying config or killing listener', async t => {
 const port = await listener(t)
 const workspace = await make_workspace(); t.after(workspace.cleanup)
 const content = `port: ${port}\n`
 await fs.writeFile(`${workspace.work}/server.yaml`, content)
 const result = await run_cli(['dev'], { cwd: workspace.work, home: workspace.home })
 assert.notEqual(result.code, 0)
 assert.match(result.output, /--port/)
 assert.equal(await fs.readFile(`${workspace.work}/server.yaml`, 'utf8'), content)
 assert.equal(await is_port_in_use(port), true)
})

test('writing config preserves an explicitly configured default port', async t => {
 const workspace = await make_workspace(); t.after(workspace.cleanup)
 await write_server_config(workspace.work, { port: 3000 })
 assert.equal((await read_server_config(workspace.work)).port, 3000)
})
