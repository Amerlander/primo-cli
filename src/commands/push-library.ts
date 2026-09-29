import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import ora from 'ora'
import archiver from 'archiver'
import { prepare_push, append_push_guard, finish_push } from '../utils/push-guard.js'
import { get_auth_token } from '../utils/auth.js'
import { normalize_server_url } from '../utils/server-config.js'

interface PushLibraryOptions {
	server?: string
	dir: string
	token?: string
	force?: boolean
	yes?: boolean
}

function is_local_server(server: string): boolean {
	try {
		const url = new URL(server)
		return url.hostname === 'localhost' || url.hostname === '127.0.0.1'
	} catch {
		return false
	}
}

export async function push_library(options: PushLibraryOptions) {
	const spinner = ora('Reading local library...').start()

	try {
		const workspace_dir = path.resolve(options.dir)
		const library_dir = path.join(workspace_dir, 'library')

		try {
			const stat = await fs.stat(library_dir)
			if (!stat.isDirectory()) {
				throw new Error('not a directory')
			}
		} catch {
			spinner.fail(`Library directory not found at ${chalk.cyan(library_dir)}.`)
			process.exit(1)
		}

		const server = options.server ? normalize_server_url(options.server) : undefined
		if (!server) {
			spinner.fail('Server URL required. Pass it as the first argument or use --server.')
			process.exit(1)
		}

		const token = options.token || await get_auth_token(server)
		if (!token && !is_local_server(server)) {
			spinner.fail('Authentication required. Use --token or run `primo login` first.')
			process.exit(1)
		}

		spinner.stop()
		const [plan] = await prepare_push([{dir: workspace_dir, server, target: 'library', token, label: 'library'}], options)
		spinner.start('Packaging library...')
		const zip_buffer = await create_library_zip(workspace_dir)

		spinner.text = 'Pushing library...'
		const form_data = new FormData()
		form_data.append('file', new Blob([zip_buffer]), 'library.zip')
		append_push_guard(form_data, plan)

		const headers: Record<string, string> = {}
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}

		const response = await fetch(`${server}/api/primo/import-library`, {
			method: 'POST',
			headers,
			body: form_data
		})

		if (response.status === 404) {
			spinner.fail('Shared library sync is not supported by this primo server. Update the server before using `primo library push`.')
			process.exit(1)
		}

		if (!response.ok) {
			const error = await response.text()
			spinner.fail(`Push failed: ${error}`)
			process.exit(1)
		}

		const result = await response.json() as {
			revision?: string
			backup?: string
			success?: boolean
			summary?: { groups: number; blocks: number }
		}

		await finish_push(plan, result)
		spinner.succeed('Library push complete')
		if (result.summary) {
			console.log('')
			console.log(chalk.dim('  Library imported:'))
			console.log(chalk.dim(`    groups/ ${result.summary.groups}`))
			console.log(chalk.dim(`    blocks/ ${result.summary.blocks}`))
		}
	} catch (error) {
		spinner.fail(`Push failed: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}
}

async function create_library_zip(workspace_dir: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const archive = archiver('zip', { zlib: { level: 9 } })
		const chunks: Buffer[] = []

		archive.on('data', (chunk) => chunks.push(chunk))
		archive.on('end', () => resolve(Buffer.concat(chunks)))
		archive.on('error', reject)

		archive.directory(path.join(workspace_dir, 'library'), 'library')
		archive.finalize()
	})
}
