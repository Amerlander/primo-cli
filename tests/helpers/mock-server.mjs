import http from 'http'
import archiver from 'archiver'

/**
 * A stand-in for a Primo server, just complete enough for the CLI to talk to.
 *
 * The point is to assert the request the CLI actually makes — path, method,
 * auth header — rather than to reimplement the server. Published 0.1.10 and
 * 0.1.11 both shipped a dist that called the old /api/palacms/* routes and
 * 404'd against every real server; nothing in this repo would have noticed.
 * Recording requests here is what makes that class of break visible.
 */
export async function start_mock_server({ sites = [], export_files = {}, site_groups = [], revisions = {}, on_request, unsupported_guard = false, legacy_export = false } = {}) {
	const requests = []
	const initial_revision = 'v1:' + 'a'.repeat(64)
	for (const site of sites) revisions[site.id] ??= initial_revision
	revisions.library ??= initial_revision
	let sequence = 1

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1')
		const body = await read_body(req)
		requests.push({
			method: req.method,
			path: url.pathname,
			query: Object.fromEntries(url.searchParams),
			authorization: req.headers.authorization ?? null,
			content_type: req.headers['content-type'] ?? null,
			body_length: body.length, body
		})

		if (on_request) await on_request({ req, url, body, revisions, requests })
		const state_match = url.pathname.match(/^\/api\/primo\/push-state\/([^/]+)$/)
		if (state_match && !unsupported_guard) {
			const target = state_match[1]
			return json(res, 200, { protocol: 1, exists: revisions[target] !== 'absent', revision: revisions[target] || 'absent' })
		}
		if (url.pathname.includes('/api/primo/push-backups/')) {
			const zip = await make_zip(export_files)
			res.writeHead(200, { 'Content-Type': 'application/zip' })
			return res.end(zip)
		}

		if (url.pathname === '/api/health') {
			return json(res, 200, { status: 'ok' })
		}

		if (url.pathname === '/api/primo/dev-auth' && req.method === 'POST') {
			return json(res, 200, { token: 'dev-token' })
		}

		if (url.pathname === '/api/collections/sites/records') {
			return json(res, 200, { items: sites, page: 1, perPage: 200, totalItems: sites.length })
		}

		const site_record_match = url.pathname.match(/^\/api\/collections\/sites\/records\/([^/]+)$/)
		if (site_record_match && req.method === 'GET') {
			const site = sites.find((candidate) => candidate.id === site_record_match[1])
			if (!site) return json(res, 404, { message: 'no such site' })
			return json(res, 200, site)
		}

		if (url.pathname === '/api/collections/site_groups/records') {
			return json(res, 200, { items: site_groups, page: 1, perPage: 200, totalItems: site_groups.length })
		}

		const export_match = url.pathname.match(/^\/api\/primo\/export\/([^/]+)$/)
		if (export_match && req.method === 'GET') {
			const site_id = export_match[1]
			if (!sites.some((site) => site.id === site_id)) {
				return json(res, 404, { message: 'no such site' })
			}
			const zip = await make_zip(export_files)
			res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, ...(!legacy_export ? {'X-Primo-Revision':revisions[site_id]} : {}) })
			return res.end(zip)
		}

		if (url.pathname === '/api/primo/export-library' && req.method === 'GET') {
			const zip = await make_zip({ 'blocks/.keep': '' })
			res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, ...(!legacy_export ? {'X-Primo-Revision':revisions.library} : {}) })
			return res.end(zip)
		}

		const import_match = url.pathname.match(/^\/api\/primo\/import\/([^/]+)(\/preview)?$/)
		if ((import_match || url.pathname === '/api/primo/import-library') && req.method === 'POST') {
			const target = import_match ? import_match[1] : 'library'
			const form = await new Response(body, {headers: {'Content-Type':req.headers['content-type']}}).formData()
			if (!import_match?.[2] && form.get('expected_revision') !== revisions[target]) return json(res, 409, {message:'Server changed after preflight'})
			if (!import_match?.[2]) revisions[target] = 'v1:' + (++sequence).toString(16).padStart(64, '0')
			return json(res, 200, {
				success: true, revision: revisions[target],
				backup: form.get('force') === 'true' ? 'backup-1234.zip' : '',
				diff: {pages:{added:[],modified:['index'],deleted:[]}}, summary:{groups:1,blocks:1}, created_ids:{}
			})
		}

		return json(res, 404, { message: `unhandled ${req.method} ${url.pathname}` })
	})

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address()

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		revisions,
		/** Every recorded request whose path matches, for order-independent assertions. */
		matching: (pattern) => requests.filter((r) => (typeof pattern === 'string' ? r.path === pattern : pattern.test(r.path))),
		close: () => new Promise((resolve) => server.close(resolve))
	}
}

function json(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
	res.end(body)
}

function read_body(req) {
	return new Promise((resolve) => {
		const chunks = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('end', () => resolve(Buffer.concat(chunks)))
	})
}

/** Builds the zip the export endpoints return, from a {path: contents} map. */
function make_zip(files) {
	return new Promise((resolve, reject) => {
		const archive = archiver('zip', { zlib: { level: 0 } })
		const chunks = []
		archive.on('data', (chunk) => chunks.push(chunk))
		archive.on('error', reject)
		archive.on('end', () => resolve(Buffer.concat(chunks)))
		for (const [name, contents] of Object.entries(files)) {
			archive.append(contents, { name })
		}
		archive.finalize()
	})
}
