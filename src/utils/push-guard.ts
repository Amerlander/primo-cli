import fs from 'fs/promises'
import path from 'path'
import inquirer from 'inquirer'
import { normalize_server_url } from './server-config.js'

export interface PushTarget {
	dir: string
	server: string
	target: string
	token?: string | null
	label: string
}

export interface PushPlan extends PushTarget {
	revision: string
	exists: boolean
	force: boolean
}

interface Baseline { revision: string }
const revision_valid = (value: unknown): value is string => typeof value === 'string' && /^(absent|v1:[a-f0-9]{64})$/.test(value)
const state_path = (dir: string) => path.join(dir, '.primo', 'sync-state.json')
const state_key = (server: string, target: string) => JSON.stringify([normalize_server_url(server), target])

async function read_baselines(dir: string): Promise<Record<string, Baseline>> {
	try {
		const value = JSON.parse(await fs.readFile(state_path(dir), 'utf8'))
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sync-state.json')
		return value
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
		throw error
	}
}

// Save only the revision of the exact export/import response, never one fetched
// afterward: that could bless a client edit our local files have never seen.
export async function save_baseline(dir: string, server: string, target: string, revision: string | null) {
	const baselines = await read_baselines(dir)
	const key = state_key(server, target)
	if (revision_valid(revision)) baselines[key] = { revision }
	else delete baselines[key] // A legacy/failed pull must not retain an old baseline.
	await fs.mkdir(path.dirname(state_path(dir)), { recursive: true })
	const temp = `${state_path(dir)}.${process.pid}.tmp`
	await fs.writeFile(temp, JSON.stringify(baselines, null, 2) + '\n', { mode: 0o600 })
	await fs.rename(temp, state_path(dir))
}

export async function prepare_push(targets: PushTarget[], options: { force?: boolean; yes?: boolean; preview?: boolean }): Promise<PushPlan[]> {
	const identities = targets.map(target => state_key(target.server, target.target))
	if (new Set(identities).size !== identities.length) throw new Error('Multiple local folders target the same server site. Push stopped before any uploads.')
	const plans: PushPlan[] = []
	const errors: string[] = []
	for (const target of targets) {
		try {
			const response = await fetch(`${target.server}/api/primo/push-state/${encodeURIComponent(target.target)}`, {
				headers: target.token ? { Authorization: `Bearer ${target.token}` } : {},
				signal: AbortSignal.timeout(30000)
			})
			if (response.status === 404) throw new Error('Server does not support safe pushes. Update the CMS first; no upload was attempted.')
			if (!response.ok) throw new Error(await response_error(response))
			const state = await response.json() as { protocol?: number; exists?: boolean; revision?: string }
			if (state.protocol !== 1 || typeof state.exists !== 'boolean' || !revision_valid(state.revision)) {
				throw new Error('Server returned an invalid push revision; cannot verify that pushing is safe.')
			}
			const baseline = (await read_baselines(target.dir))[state_key(target.server, target.target)]
			const stale = baseline ? baseline.revision !== state.revision : state.exists
			if (stale && !options.force && !options.preview) {
				throw new Error(baseline
					? 'changed on the server since the last sync (or was deleted).'
					: 'has no saved baseline for this server. Pull first, or explicitly overwrite with --force.')
			}
			if (stale && options.preview) console.log(`  ${target.label}: server changes detected; a normal push would be blocked.`)
			plans.push({ ...target, revision: state.revision, exists: state.exists, force: !!options.force && !options.preview })
		} catch (error) {
			errors.push(`${target.label}: ${error instanceof Error ? error.message : error}`)
		}
	}
	if (errors.length) throw new Error(`Push stopped before any uploads:\n  ${errors.join('\n  ')}\nNothing was changed. Save your local work before pulling. An intentional overwrite requires --force.`)
	const overwrites = plans.filter(plan => plan.force && plan.exists)
	if (overwrites.length) {
		console.log('The following server data will be replaced with your local files:')
		for (const plan of overwrites) console.log(`  ${plan.label} (${plan.server})`)
		console.log('A server backup will be created before each overwrite. Edits after this check will still stop the push.')
		if (!options.yes) {
			if (!process.stdin.isTTY) throw new Error('Overwrite requires confirmation. For non-interactive use, explicitly pass --force --yes.')
			const { proceed } = await inquirer.prompt([{ type: 'confirm', name: 'proceed', message: 'Replace this server data with your local files?', default: false }])
			if (!proceed) throw new Error('Push cancelled. Nothing was changed.')
		}
	}
	return plans
}

export function append_push_guard(form: FormData, plan: PushPlan) {
	form.append('expected_revision', plan.revision)
	if (plan.force) form.append('force', 'true')
}

export async function response_error(response: Response): Promise<string> {
	const text = await response.text()
	try { return JSON.parse(text).message || text } catch { return text }
}

export async function finish_push(plan: PushPlan, result: { revision?: string; backup?: string }) {
	if (!revision_valid(result.revision)) throw new Error('Server applied the push but did not return a valid revision. Pull before pushing again.')
	try {
		await save_baseline(plan.dir, plan.server, plan.target, result.revision)
	} catch (error) {
		throw new Error(`Server applied the push, but saving its local baseline failed: ${error instanceof Error ? error.message : error}. Pull before pushing again.`)
	}
	if (plan.force && plan.exists && !result.backup) throw new Error('Server applied the overwrite but did not return a backup reference. Check server backups before proceeding.')
	if (!result.backup) return
	if (!/^backup-[0-9]+\.zip$/.test(result.backup)) throw new Error('Server returned an invalid backup reference.')
	const url = `${plan.server}/api/primo/push-backups/${encodeURIComponent(plan.target)}/${result.backup}`
	console.log(`  Server backup: ${url}`)
	try {
		const response = await fetch(url, {
			headers: plan.token ? { Authorization: `Bearer ${plan.token}` } : {},
			signal: AbortSignal.timeout(60000)
		})
		if (!response.ok) throw new Error(await response_error(response))
		const backup_dir = path.join(plan.dir, '.primo', 'backups', plan.target)
		await fs.mkdir(backup_dir, { recursive: true })
		const file = path.join(backup_dir, result.backup)
		await fs.writeFile(file, Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
		console.log(`  Local backup: ${file}`)
	} catch (error) {
		console.warn(`  Could not download the backup; the server copy is retained at the URL above: ${error instanceof Error ? error.message : error}`)
	}
}
