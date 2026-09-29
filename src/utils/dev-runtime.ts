import fs from 'fs/promises'
import { readFileSync, unlinkSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

export const RUNTIME_FILE = '.primo/dev-server.json'

export interface DevRuntime {
	version: 1
	workspace: string
	pid: number
	cms_pid?: number
	port: number
	instance: string
}

export function process_is_alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try { process.kill(pid, 0); return true } catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

export function runtime_has_live_process(runtime: DevRuntime): boolean {
	return process_is_alive(runtime.pid) || (runtime.cms_pid !== undefined && process_is_alive(runtime.cms_pid))
}

export async function read_dev_runtime(dir: string): Promise<DevRuntime | null> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(dir, RUNTIME_FILE), 'utf8'))
		if (value.version !== 1 || value.workspace !== await fs.realpath(dir)
			|| !Number.isInteger(value.port) || value.port < 1 || value.port > 65534
			|| !Number.isInteger(value.pid) || typeof value.instance !== 'string') return null
		return value
	} catch { return null }
}

export async function runtime_is_running(runtime: DevRuntime): Promise<boolean> {
	if (!process_is_alive(runtime.pid)) return false
	try {
		const response = await fetch(`http://127.0.0.1:${runtime.port + 1}/__primo/runtime`, { signal: AbortSignal.timeout(1000) })
		if (!response.ok) return false
		const identity = await response.json() as DevRuntime
		return identity.instance === runtime.instance && identity.workspace === runtime.workspace
	} catch { return false }
}

// Persist a workspace-owned session, including during startup, so a second
// command cannot open the same database merely because it found another port.
export async function claim_dev_runtime(dir: string, port: number): Promise<DevRuntime> {
	const file = path.join(dir, RUNTIME_FILE)
	await fs.mkdir(path.dirname(file), { recursive: true })
	const previous = await read_dev_runtime(dir)
	if (previous && runtime_has_live_process(previous)) {
		throw new Error(`This workspace already has a Primo server running or starting on port ${previous.port}. Stop it before starting another.`)
	}
	if (previous) await fs.unlink(file).catch(() => {})
	const runtime: DevRuntime = { version: 1, workspace: await fs.realpath(dir), pid: process.pid, port, instance: randomUUID() }
	try {
		await fs.writeFile(file, JSON.stringify(runtime, null, 2) + '\n', { flag: 'wx' })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A dev server session already exists in ${file}. Stop that server first; remove the file only if it is stale.`)
		throw error
	}
	// Synchronous exit cleanup also covers startup failures and Ctrl+C before
	// the normal watcher shutdown handlers have been installed.
	process.once('exit', () => {
		try {
			if (JSON.parse(readFileSync(file, 'utf8')).instance === runtime.instance) unlinkSync(file)
		} catch { /* already removed */ }
	})
	return runtime
}

export async function record_cms_process(dir: string, runtime: DevRuntime, pid: number): Promise<void> {
	runtime.cms_pid = pid
	const file = path.join(dir, RUNTIME_FILE)
	const temporary = `${file}.${runtime.instance}.tmp`
	await fs.writeFile(temporary, JSON.stringify(runtime, null, 2) + '\n')
	await fs.rename(temporary, file)
}

export async function resolve_dev_server(dir: string, configured_port = 3000): Promise<{ port: number; url: string; running: boolean; managed: boolean }> {
	const runtime = await read_dev_runtime(dir)
	const port = runtime?.port ?? configured_port
	const url = `http://127.0.0.1:${port}`
	if (runtime) return { port, url, running: await runtime_is_running(runtime), managed: true }
	try {
		// Older CLIs do not write runtime metadata. When a newer server answers
		// on the configured port, check its workspace before treating it as ours.
		const identity = await fetch(`http://127.0.0.1:${port + 1}/__primo/runtime`, { signal: AbortSignal.timeout(500) })
		const value = await identity.json() as DevRuntime
		if (value.version === 1 && typeof value.workspace === 'string') {
			return { port, url, running: identity.ok && value.workspace === await fs.realpath(dir), managed: false }
		}
	} catch { /* legacy server */ }
	let running = false
	try { running = (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(500) })).ok } catch { /* offline */ }
	return { port, url, running, managed: false }
}

export async function find_dev_workspace(start: string): Promise<string | null> {
	let dir = path.resolve(start)
	for (;;) {
		try { await fs.access(path.join(dir, 'server.yaml')); return dir } catch { /* walk up */ }
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}
