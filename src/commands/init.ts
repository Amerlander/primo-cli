import fs from 'fs/promises'
import path from 'path'
import chalk from 'chalk'
import ora from 'ora'
import inquirer from 'inquirer'
import { SITE_CONFIG_FILE } from '../utils/site-config.js'
import { SERVER_CONFIG_FILE, read_server_config, write_server_config } from '../utils/server-config.js'
import { detect_clients, get_client, path_context } from '../utils/mcp-clients.js'
import { run_mcp_wiring, type ClientResult } from '../utils/mcp-wiring.js'

interface InitOptions {
	name?: string
	/** `--no-mcp` sets this false; wiring prompts by default. */
	mcp?: boolean
	/** `--yes` wires detected clients without prompting (CI/scripts). */
	yes?: boolean
}

export async function init_workspace(options: InitOptions) {
	const cwd = process.cwd()

	// Refuse to init inside a site directory
	try {
		await fs.access(path.join(cwd, SITE_CONFIG_FILE))
		console.log(chalk.red(`Found ${SITE_CONFIG_FILE} in the current directory.`))
		console.log(chalk.red('Run `primo init` from outside a site directory.'))
		process.exit(1)
	} catch {
		// Not inside a site directory, continue.
	}

	// If a name is provided, create that folder and init inside it.
	// Otherwise, init in cwd.
	let base_dir = cwd
	if (options.name) {
		if (!/^[a-z0-9.-]+$/i.test(options.name)) {
			console.log(chalk.red('Name must contain only letters, numbers, dots, and hyphens.'))
			process.exit(1)
		}
		base_dir = path.join(cwd, options.name)
		try {
			await fs.access(base_dir)
			console.log(chalk.red(`Directory "${options.name}" already exists`))
			process.exit(1)
		} catch {
			// Directory doesn't exist, good to proceed
		}
	}

	const server_config_path = path.join(base_dir, SERVER_CONFIG_FILE)

	// If cwd init, bail if a server is already here.
	if (!options.name) {
		try {
			await fs.access(server_config_path)
			console.log(chalk.red(`Workspace already initialized (${SERVER_CONFIG_FILE} exists).`))
			console.log(chalk.dim('Run `primo new <site>` to add a site.'))
			process.exit(1)
		} catch {
			// No server config, good to proceed
		}
	}

	const spinner = ora('Initializing workspace...').start()

	try {
		await fs.mkdir(base_dir, { recursive: true })
		await fs.mkdir(path.join(base_dir, 'sites'), { recursive: true })
		await fs.mkdir(path.join(base_dir, 'library'), { recursive: true })

		await write_server_config(base_dir, {
			site_groups: [
				{
					id: 'default',
					name: 'Default',
					index: 0
				}
			]
		})

		// Re-read and ensure default group is present (normalize round-trip)
		const server_config = await read_server_config(base_dir)
		const site_groups = server_config.site_groups ?? []
		if (!site_groups.some((group) => group.id === 'default')) {
			site_groups.push({
				id: 'default',
				name: 'Default',
				index: site_groups.length
			})
			await write_server_config(base_dir, { ...server_config, site_groups })
		}

		spinner.succeed(`Workspace initialized: ${chalk.cyan(base_dir)}`)

		await wire_mcp_on_init({ base_dir, skip: options.mcp === false, yes: !!options.yes })

		const rel = path.relative(cwd, base_dir) || '.'
		console.log('')
		console.log(chalk.dim('  Next steps:'))
		if (rel !== '.') {
			console.log(chalk.dim(`    cd ${rel}`))
		}
		console.log(chalk.dim('    primo new <site-name>'))
		console.log('')
	} catch (error) {
		spinner.fail(`Failed to initialize workspace: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}
}

/**
 * Offer to connect the user's MCP clients during init — the first onboarding
 * moment. Default is to prompt; `--no-mcp` skips, `--yes` wires detected
 * clients without prompting, and a non-TTY run prints a hint instead of
 * blocking or silently writing config.
 */
async function wire_mcp_on_init(options: { base_dir: string; skip: boolean; yes: boolean }) {
	if (options.skip) return

	const home = path_context(options.base_dir).home
	const detected = detect_clients({ cwd: options.base_dir, home })

	if (detected.length === 0) {
		console.log(chalk.dim('  Primo MCP: no agent clients detected. Run `primo mcp install` any time to connect one.'))
		return
	}

	let chosen = detected
	if (!options.yes) {
		if (!process.stdin.isTTY) {
			console.log(chalk.dim(`  Primo MCP: detected ${detected.join(', ')}. Run \`primo mcp install\` to wire them.`))
			return
		}
		const answers = await inquirer.prompt([{
			type: 'checkbox',
			name: 'clients',
			message: 'Wire Primo MCP into:',
			choices: detected.map((id) => ({ name: get_client(id)?.name || id, value: id, checked: true }))
		}])
		chosen = (answers.clients as string[]) || []
		if (chosen.length === 0) {
			console.log(chalk.dim('  Primo MCP: skipped.'))
			return
		}
	}

	let results: ClientResult[]
	try {
		;({ results } = await run_mcp_wiring({ clients: chosen, cwd: options.base_dir }))
	} catch (error) {
		console.log(chalk.yellow(`  Primo MCP: ${error instanceof Error ? error.message : error}`))
		return
	}

	print_wire_summary(results)
}

function print_wire_summary(results: ClientResult[]) {
	if (results.length === 0) return
	console.log('')
	console.log(chalk.dim('  Primo MCP'))
	for (const result of results) {
		if (result.changed) {
			console.log(`    ${chalk.green('✓')} ${result.name} ${chalk.dim('wired — restart the client to load the tools')}`)
		} else if (result.action === 'unchanged') {
			console.log(`    ${chalk.green('✓')} ${result.name} ${chalk.dim('already wired')}`)
		} else if (result.action === 'manual' || result.action === 'skip') {
			console.log(`    ${chalk.yellow('!')} ${result.name} ${chalk.dim(`needs manual setup — \`primo mcp print --client ${result.client}\``)}`)
		} else {
			console.log(`    ${chalk.yellow('!')} ${result.name} ${chalk.dim(result.reason || result.action)}`)
		}
	}
}
