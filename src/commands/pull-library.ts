import { find_dev_workspace, resolve_dev_server } from '../utils/dev-runtime.js'
import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import ora from 'ora'
import extract from 'extract-zip'
import { get_auth_token } from '../utils/auth.js'
import { read_server_config, normalize_server_url } from '../utils/server-config.js'

interface PullLibraryOptions {
	server?: string
	output?: string
	token?: string
}

async function detect_server(): Promise<string | null> {
	const workspace = await find_dev_workspace(process.cwd())
	if (workspace) {
		const config = await read_server_config(workspace)
		const server = await resolve_dev_server(workspace, config.port)
		if (!server.running) throw new Error(`No running Primo server for this workspace. Start primo dev, or pass --server <url>.`)
		return server.url
	}
	const ports = [3000, 8080, 5173]

	for (const port of ports) {
		try {
			const url = `http://127.0.0.1:${port}`
			const response = await fetch(`${url}/api/health`, {
				signal: AbortSignal.timeout(500)
			})
			if (response.ok) {
				return url
			}
		} catch {
			// Not running on this port
		}
	}

	return null
}

export async function pull_library(options: PullLibraryOptions) {
	const spinner = ora('Connecting...').start()

	try {
		let server: string
		if (options.server) {
			server = normalize_server_url(options.server)
		} else {
			spinner.text = 'Looking for local server...'
			const detected = await detect_server()
			server = (detected || 'http://localhost:3000').replace(/\/+$/, '')
			spinner.text = `Using ${server}`
		}

		const token = options.token || await get_auth_token(server)
		const headers: Record<string, string> = {}
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}

		const output_dir = path.resolve(options.output || '.')
		await fs.mkdir(output_dir, { recursive: true })

		spinner.text = 'Exporting library...'
		const response = await fetch(`${server}/api/primo/export-library`, {
			headers
		})

		if (response.status === 404) {
			spinner.fail('Shared library sync is not supported by this primo server. Update the server before using `primo library pull`.')
			process.exit(1)
		}

		if (!response.ok) {
			const error = await response.text()
			spinner.fail(`Export failed: ${error}`)
			process.exit(1)
		}

		const zip_data = await response.arrayBuffer()
		const temp_zip = path.join(output_dir, '.primo-library-export.zip')
		await fs.writeFile(temp_zip, Buffer.from(zip_data))

		spinner.text = 'Extracting library...'
		await extract(temp_zip, { dir: output_dir })
		await fs.unlink(temp_zip)

		const summary = await count_library(path.join(output_dir, 'library'))

		spinner.succeed(`Library exported to ${chalk.cyan(path.join(output_dir, 'library'))}`)
		console.log('')
		console.log(chalk.dim('  Library exported:'))
		console.log(chalk.dim(`    groups/ ${summary.groups}`))
		console.log(chalk.dim(`    blocks/ ${summary.blocks}`))
	} catch (error) {
		spinner.fail(`Export failed: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}
}

async function count_library(library_dir: string): Promise<{ groups: number; blocks: number }> {
	const counts = { groups: 0, blocks: 0 }

	try {
		const entries = await fs.readdir(library_dir, { withFileTypes: true })
		const groups = entries.filter((entry) => entry.isDirectory())
		counts.groups = groups.length

		for (const group of groups) {
			const group_dir = path.join(library_dir, group.name)
			const block_entries = await fs.readdir(group_dir, { withFileTypes: true })
			counts.blocks += block_entries.filter((entry) => entry.isDirectory()).length
		}
	} catch {
		// No library directory exported
	}

	return counts
}
