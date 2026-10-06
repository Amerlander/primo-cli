import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { import_site_files } from '../dist/commands/dev.js'
import { make_workspace } from './helpers/run-cli.mjs'

// An upload-only writeback error must not suppress server warnings or prevent
// page/section IDs from being persisted after an otherwise successful import.
test('dev upload writeback failures retain content IDs and import warnings', async t => {
	for (const bootstrap of [false, true]) {
		for (const failure of ['manifest', 'yaml', 'cache']) {
			await t.test(`${bootstrap ? 'bootstrap' : 'import'}: ${failure}`, async t => {
				const workspace = await make_workspace()
				t.after(workspace.cleanup)
				const site = path.join(workspace.work, 'sites/demo')
				for (const dir of ['pages', 'blocks', 'uploads']) await fs.mkdir(path.join(site, dir), { recursive: true })
				await fs.writeFile(path.join(site, 'site.yaml'), 'name: Demo\nsite_id: devuploadtest01\n')
				await fs.writeFile(path.join(site, 'pages/index.yaml'), 'name: Home\nsections:\n  - block: hero\n    content: {}\n')
				await fs.writeFile(path.join(site, 'uploads/hero.png'), 'image bytes')
				if (failure === 'manifest') await fs.writeFile(path.join(site, 'uploads/.manifest.json'), '{broken JSON')
				if (failure === 'yaml') await fs.writeFile(path.join(site, 'blocks/broken.yaml'), 'image: [\nupload: uploadrecord001\n')
				if (failure === 'cache') await fs.mkdir(path.join(site, '.primo/dev-upload-paths.json'), { recursive: true })
				const warnings = [{ kind: 'orphaned_field', file: 'pages/index.yaml', path: 'sections[0].content.unknown', message: 'Server reported an unknown field' }]
				const server = http.createServer(async (req, res) => {
					for await (const chunk of req) { /* Consume the uploaded site zip. */ }
					res.setHeader('Content-Type', 'application/json')
					res.end(JSON.stringify({
						warnings,
						created_ids: {
							'uploads/.manifest.json': { _uploads: { 'hero.png': { id: 'uploadrecord001', hash: 'image-hash' } } },
							'pages/index.yaml': { _id: 'pagerecord00001', sections: ['sectionrecord01'] }
						}
					}))
				})
				await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
				t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
				const port = server.address().port
				const logged = []
				const original_log = console.log
				console.log = (...args) => logged.push(args.join(' '))
				let result
				try {
					result = await import_site_files(site, `http://127.0.0.1:${port}`, { name: 'Demo', site_id: 'devuploadtest01' }, port, { format: { enabled: false } }, bootstrap, workspace.work)
				} finally {
					console.log = original_log
				}
				assert.equal(result.ok, true)
				assert.equal(result.warning_count, 1)
				assert.equal(result.dropped_field_count, 1)
				assert.equal(result.warning_details[0].kind, 'orphaned_field')
				const page = load(await fs.readFile(path.join(site, 'pages/index.yaml'), 'utf8'))
				assert.equal(page._id, 'pagerecord00001')
				assert.equal(page.sections[0]._id, 'sectionrecord01')
				assert.ok(logged.some(line => line.includes('Upload source writeback failed:')))
				assert.ok(logged.some(line => line.includes('Server reported an unknown field')))
			})
		}
	}
})
