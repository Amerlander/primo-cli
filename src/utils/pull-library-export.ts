import fs from 'fs/promises'
import path from 'path'
import extract from 'extract-zip'
import { save_baseline } from './push-guard.js'

// Install the exact exported library before recording its revision. Overlaying
// a ZIP leaves locally stale blocks behind after a server-side deletion, which
// would let the next push resurrect data under an incorrectly fresh baseline.
export async function install_library_export(archive: string, root: string, server: string, revision: string | null) {
	const state_dir = path.join(root, '.primo')
	await fs.mkdir(state_dir, { recursive: true })
	const temp = await fs.mkdtemp(path.join(state_dir, 'library-pull-'))
	try {
		await extract(archive, { dir: temp })
		await save_baseline(root, server, 'library', null)
		const destination = path.join(root, 'library')
		const trash = path.join(state_dir, 'trash', path.basename(temp))
		await fs.mkdir(path.dirname(trash), { recursive: true })
		try {
			await fs.rename(destination, trash)
			console.log(`  Previous local library saved to ${trash}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		// An empty server library can legitimately export no library/ entries.
		await fs.mkdir(path.join(temp, 'library'), { recursive: true })
		await fs.rename(path.join(temp, 'library'), destination)
		await save_baseline(root, server, 'library', revision)
	} finally {
		await fs.rm(temp, { recursive: true, force: true })
	}
}
