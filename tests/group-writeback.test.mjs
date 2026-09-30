import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { load } from 'js-yaml'
import { make_workspace } from './helpers/run-cli.mjs'
import { apply_server_group_id } from '../dist/commands/dev.js'

/**
 * `apply_server_group_id` writes the id the CMS actually stored back into
 * `server.yaml` (and `site.yaml` when it referenced the group by id), so the
 * files stop pointing at an id the database never had.
 */

const CMS_ID = 'cmsgroupid00001'

async function seed(workspace, { server_id, name, site_group }) {
	const site_dir = path.join(workspace.work, 'sites', 'demo')
	await fs.mkdir(site_dir, { recursive: true })
	await fs.writeFile(
		path.join(workspace.work, 'server.yaml'),
		`site_groups:\n  - id: ${server_id}\n    name: ${name}\n    index: 0\n`
	)
	await fs.writeFile(path.join(site_dir, 'site.yaml'), `name: Demo\nsite_id: abc123abc123abc\ngroup: ${site_group}\n`)
	return {
		site_dir,
		server_config: { site_groups: [{ id: server_id, name, index: 0 }] },
		config: { name: 'Demo', site_id: 'abc123abc123abc', group: site_group }
	}
}

describe('apply_server_group_id', () => {
	test('updates server.yaml and a site.yaml id reference', async () => {
		const workspace = await make_workspace()
		try {
			const { site_dir, server_config, config } = await seed(workspace, {
				server_id: 'architecture1',
				name: 'Architecture & Interior Design',
				site_group: 'architecture1'
			})

			await apply_server_group_id(CMS_ID, site_dir, config, server_config, workspace.work)

			const server = load(await fs.readFile(path.join(workspace.work, 'server.yaml'), 'utf8'))
			assert.equal(server.site_groups[0].id, CMS_ID)
			assert.equal(server.site_groups[0].name, 'Architecture & Interior Design')

			const site = load(await fs.readFile(path.join(site_dir, 'site.yaml'), 'utf8'))
			assert.equal(site.group, CMS_ID)
		} finally {
			await workspace.cleanup()
		}
	})

	test('updates server.yaml but leaves a site.yaml name reference as a name', async () => {
		const workspace = await make_workspace()
		try {
			const { site_dir, server_config, config } = await seed(workspace, {
				server_id: 'architecture1',
				name: 'Architecture & Interior Design',
				site_group: 'Architecture & Interior Design'
			})

			await apply_server_group_id(CMS_ID, site_dir, config, server_config, workspace.work)

			const server = load(await fs.readFile(path.join(workspace.work, 'server.yaml'), 'utf8'))
			assert.equal(server.site_groups[0].id, CMS_ID)

			const site = load(await fs.readFile(path.join(site_dir, 'site.yaml'), 'utf8'))
			assert.equal(site.group, 'Architecture & Interior Design', 'a name reference should be left alone')
		} finally {
			await workspace.cleanup()
		}
	})

	test('is a no-op when the server id already matches', async () => {
		const workspace = await make_workspace()
		try {
			const { site_dir, server_config, config } = await seed(workspace, {
				server_id: CMS_ID,
				name: 'Architecture & Interior Design',
				site_group: CMS_ID
			})
			const before = await fs.readFile(path.join(workspace.work, 'server.yaml'), 'utf8')

			await apply_server_group_id(CMS_ID, site_dir, config, server_config, workspace.work)

			assert.equal(await fs.readFile(path.join(workspace.work, 'server.yaml'), 'utf8'), before)
		} finally {
			await workspace.cleanup()
		}
	})
})

test('write_server_config keeps one entry per group id and heals existing duplicates', async () => {
	const { write_server_config, read_server_config } = await import('../dist/utils/server-config.js')
	const dir = await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'groups-'))
	await write_server_config(dir, { site_groups: [
		{ id: 'okwtvqfzrek51by', name: 'Default', index: 0 },
		{ id: 'okwtvqfzrek51by', name: 'Default', index: 1 },
		{ id: 'clientsgroup001', name: 'Clients', index: 2 }
	] })
	const { site_groups } = await read_server_config(dir)
	assert.deepEqual(site_groups.map(g => [g.id, g.index]), [['okwtvqfzrek51by', 0], ['clientsgroup001', 1]])
})
