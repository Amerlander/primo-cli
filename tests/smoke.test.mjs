import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { save_baseline } from '../dist/utils/push-guard.js'
import { start_mock_server } from './helpers/mock-server.mjs'
import { run_cli, make_workspace, CLI_ENTRY } from './helpers/run-cli.mjs'

/**
 * Smoke coverage for the published surface of the CLI.
 *
 * Scope is deliberately narrow: does the built dist run, and does it call the
 * endpoints the server actually serves. That's the failure mode this package
 * has shipped before — 0.1.10 and 0.1.11 went out with a dist calling the
 * retired /api/palacms/* routes, so `primo pull` 404'd for every user until
 * 0.1.12. Deep behaviour (sync semantics, conflict handling, watching) belongs
 * in the primocms e2e suite, which drives this CLI against a real server.
 */

const SITE = { id: 'test_site_00001', name: 'Smoke Site', host: 'test_site_00001', group: '' }

const EXPORT_FILES = {
	'pages/index.yaml': 'name: Home\nfields: {}\n',
	'blocks/hero/component.svelte': '<h1>hi</h1>\n'
}

describe('built CLI', () => {
	let workspace

	before(async () => {
		workspace = await make_workspace()
	})
	after(async () => {
		await workspace.cleanup()
	})

	// If dist is missing or was built from broken source, every other test here
	// fails in a confusing way. Check it up front with a clear message.
	test('dist entrypoint exists and executes', async () => {
		await assert.doesNotReject(fs.access(CLI_ENTRY), `${CLI_ENTRY} missing — run 'npm run build' first`)

		const result = await run_cli(['--version'], { cwd: workspace.work, home: workspace.home })
		assert.equal(result.code, 0, `--version exited ${result.code}: ${result.output}`)

		const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
		assert.match(result.stdout.trim(), new RegExp(pkg.version.replace(/\./g, '\\.')), `--version printed ${result.stdout.trim()}, expected ${pkg.version}`)
	})

	test('help lists the commands the README documents', async () => {
		const result = await run_cli(['--help'], { cwd: workspace.work, home: workspace.home })
		assert.equal(result.code, 0, result.output)
		for (const command of ['pull', 'push', 'dev', 'add']) {
			assert.match(result.output, new RegExp(`\\b${command}\\b`), `'${command}' missing from --help`)
		}
	})
})

describe('primo pull', () => {
	let server
	let workspace

	before(async () => {
		server = await start_mock_server({ sites: [SITE], export_files: EXPORT_FILES })
		workspace = await make_workspace()
		await workspace.write_token(server.url, 'test-token')
	})
	after(async () => {
		await server.close()
		await workspace.cleanup()
	})

	test('calls the current export routes and writes the exported files', async () => {
		// `pull [server] [dir]` — the destination is positional, not --output.
		const out = path.join(workspace.work, 'pulled')
		const result = await run_cli(['pull', server.url, out, '--token', 'test-token'], {
			cwd: workspace.work,
			home: workspace.home
		})
		assert.equal(result.code, 0, `pull failed: ${result.output}`)

		// The regression guard. These exact paths are the contract with the
		// server; a rename on either side (as in the palacms -> primo move)
		// shows up here instead of in a user's terminal.
		assert.equal(server.matching('/api/collections/sites/records').length, 1, `sites listing not requested. Saw: ${JSON.stringify(server.requests.map((r) => r.path))}`)
		const exports = server.matching(`/api/primo/export/${SITE.id}`)
		assert.equal(exports.length, 1, `export not requested at /api/primo/export/${SITE.id}. Saw: ${JSON.stringify(server.requests.map((r) => r.path))}`)
		assert.equal(exports[0].authorization, 'Bearer test-token', 'export request did not carry the bearer token')

		// The export archive is actually unpacked, not just downloaded.
		// Located rather than hard-coded: the folder layout under the output dir
		// is the server config's business, not what this test is pinning.
		const found = await find_file(out, 'index.yaml')
		assert.ok(found, `pages/index.yaml was not written anywhere under ${out}`)
		assert.match(await fs.readFile(found, 'utf8'), /name: Home/)
	})

	test('reports a failure instead of exiting 0 when the server rejects', async () => {
		const out = path.join(workspace.work, 'pull-unreachable')
		const result = await run_cli(['pull', 'http://127.0.0.1:1', out, '--token', 'test-token'], {
			cwd: workspace.work,
			home: workspace.home
		})
		assert.notEqual(result.code, 0, `unreachable server should fail, got exit 0:\n${result.output}`)
	})
})

describe('primo push', () => {
	let server
	let workspace

	before(async () => {
		server = await start_mock_server({ sites: [SITE], export_files: EXPORT_FILES })
		workspace = await make_workspace()
		await workspace.write_token(server.url, 'test-token')
	})
	after(async () => {
		await server.close()
		await workspace.cleanup()
	})

	test('posts the site archive to the import route with auth', async () => {
		const site_dir = path.join(workspace.work, 'sites', 'smoke-site')
		await fs.mkdir(path.join(site_dir, 'pages'), { recursive: true })
		await fs.writeFile(path.join(site_dir, 'site.yaml'), `name: Smoke Site\nsite_id: ${SITE.id}\nserver: ${server.url}\n`)
		await fs.writeFile(path.join(site_dir, 'pages/index.yaml'), 'name: Home\nfields: {}\n')
		await save_baseline(site_dir, server.url, SITE.id, server.revisions[SITE.id])
		await fs.writeFile(path.join(workspace.work, 'server.yaml'), `server: ${server.url}\n`)

		const result = await run_cli(['push', '--server', server.url, '--token', 'test-token'], {
			cwd: workspace.work,
			home: workspace.home
		})
		assert.equal(result.code, 0, `push failed: ${result.output}`)

		const imports = server.matching(`/api/primo/import/${SITE.id}`)
		assert.equal(imports.length, 1, `import not posted to /api/primo/import/${SITE.id}. Saw: ${JSON.stringify(server.requests.map((r) => `${r.method} ${r.path}`))}`)
		assert.equal(imports[0].method, 'POST')
		assert.equal(imports[0].authorization, 'Bearer test-token')
		assert.match(imports[0].content_type ?? '', /multipart\/form-data/, 'import body was not multipart')
		assert.ok(imports[0].body_length > 0, 'import posted an empty body')
	})
})

// Walks manually rather than using readdir's `recursive` option: that landed
// in Node 18.17, and package.json declares support from 18.0.0. On 18.0-18.16
// the option is ignored, so this would only ever see the top-level entries and
// miss the nested pages/index.yaml.
async function find_file(root, name) {
	const entries = await fs.readdir(root, { withFileTypes: true })
	for (const entry of entries) {
		const full = path.join(root, entry.name)
		if (entry.isFile() && entry.name === name) return full
		if (entry.isDirectory()) {
			const found = await find_file(full, name)
			if (found) return found
		}
	}
	return null
}
