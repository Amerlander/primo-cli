import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { load } from 'js-yaml'
import { preserve_upload_paths, prepare_dev_upload_export, remember_dev_upload_paths } from '../dist/utils/portable-uploads.js'

const image = Buffer.from('image bytes')
const hash = createHash('sha256').update(image).digest('hex')
async function fixture(t) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'primo-portable-uploads-'))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const site = path.join(root, 'site'), exported = path.join(root, 'export')
	for (const dir of [site, exported]) {
		await fs.mkdir(path.join(dir, 'uploads'), { recursive: true })
		await fs.mkdir(path.join(dir, 'site'))
		await fs.mkdir(path.join(dir, 'pages'))
	}
	const write = async (dir, file, bytes) => fs.writeFile(path.join(dir, file), bytes)
	const export_image = async (name = 'hero_local.png') => {
		await write(exported, `uploads/${name}`, image)
		await write(exported, 'uploads/.manifest.json', JSON.stringify({ [name]: { id: 'local-image-id', hash } }))
		await write(exported, 'site/content.yaml', 'favicon:\n  upload: local-image-id\n  alt: Keep this\n')
		await write(exported, 'pages/index.yaml', 'sections:\n  - content:\n      images:\n        - upload: local-image-id\ntext: local-image-id\n')
	}
	return { site, exported, write, export_image }
}

test('import writeback preserves symbolic paths, filenames and hosted manifest', async t => {
	const { site, write } = await fixture(t)
	await write(site, 'uploads/hero.png', image)
	const yaml = 'favicon:\n  upload: uploads/hero.png\n'
	const manifest = JSON.stringify({ 'hero.png': { id: 'hosted-image-id', hash } })
	await write(site, 'site/content.yaml', yaml)
	await write(site, 'uploads/.manifest.json', manifest)
	for (const id of ['local-image-id', 'hosted-new-id', 'another-local-id']) {
		await preserve_upload_paths(site, { 'hero.png': { id, canonical: 'hero_suffixed.png', hash } })
		assert.equal(await fs.readFile(path.join(site, 'site/content.yaml'), 'utf8'), yaml)
		assert.equal(await fs.readFile(path.join(site, 'uploads/.manifest.json'), 'utf8'), manifest)
		assert.deepEqual((await fs.readdir(path.join(site, 'uploads'))).sort(), ['.manifest.json', 'hero.png'])
	}
})

test('older bare IDs are recovered using stale manifest names and matching bytes', async t => {
	const { site, write } = await fixture(t)
	await write(site, 'uploads/hero_renamed.png', image)
	await write(site, 'uploads/.manifest.json', JSON.stringify({ 'hero_old.png': { id: 'old-id', hash } }))
	await write(site, 'site/content.yaml', 'favicon:\n  upload: old-id\n  alt: Keep this\n')
	await preserve_upload_paths(site, { 'hero_renamed.png': { id: 'local-id', hash } })
	assert.deepEqual(load(await fs.readFile(path.join(site, 'site/content.yaml'), 'utf8')), {
		favicon: { upload: 'uploads/hero_renamed.png', alt: 'Keep this' }
	})
})

test('CMS export and conflict snapshots keep original filenames and nested refs portable', async t => {
	const { site, exported, write, export_image } = await fixture(t)
	await write(site, 'uploads/hero.png', image)
	await export_image()
	await prepare_dev_upload_export(site, exported)
	assert.equal(load(await fs.readFile(path.join(exported, 'site/content.yaml'), 'utf8')).favicon.upload, 'uploads/hero.png')
	const page = load(await fs.readFile(path.join(exported, 'pages/index.yaml'), 'utf8'))
	assert.equal(page.sections[0].content.images[0].upload, 'uploads/hero.png')
	assert.equal(page.text, 'local-image-id')
	assert.deepEqual(await fs.readdir(path.join(site, 'uploads')), ['hero.png'])
})

test('editor-added images are copied on sync, while snapshots stay read-only', async t => {
	const { site, exported, export_image } = await fixture(t)
	await export_image()
	await prepare_dev_upload_export(site, exported)
	assert.deepEqual(await fs.readdir(path.join(site, 'uploads')), [])
	const snapshot = await fs.readFile(path.join(exported, 'site/content.yaml'), 'utf8')
	await export_image()
	await prepare_dev_upload_export(site, exported, async (file, bytes) => fs.writeFile(file, bytes))
	assert.equal(await fs.readFile(path.join(exported, 'site/content.yaml'), 'utf8'), snapshot)
	assert.deepEqual(await fs.readFile(path.join(site, 'uploads/hero_local.png')), image)
	// The following poll reuses this file instead of adding another suffix.
	await export_image()
	await prepare_dev_upload_export(site, exported, async (file, bytes) => fs.writeFile(file, bytes))
	assert.deepEqual(await fs.readdir(path.join(site, 'uploads')), ['hero_local.png'])
})

test('local image edits do not change an unchanged CMS conflict snapshot', async t => {
	const { site, exported, write, export_image } = await fixture(t)
	await write(site, 'uploads/hero.png', image)
	await remember_dev_upload_paths(site, { 'hero.png': { id: 'local-image-id', hash } })
	await export_image()
	await prepare_dev_upload_export(site, exported)
	const baseline = await fs.readFile(path.join(exported, 'site/content.yaml'), 'utf8')
	await write(site, 'uploads/hero.png', 'locally edited bytes')
	await export_image()
	await prepare_dev_upload_export(site, exported)
	assert.equal(await fs.readFile(path.join(exported, 'site/content.yaml'), 'utf8'), baseline)
	assert.deepEqual(await fs.readdir(path.join(site, 'uploads')), ['hero.png'])
})

test('CMS image sync preserves local edits and does not follow file symlinks', async t => {
	const { site, exported, write, export_image } = await fixture(t)
	await write(site, 'uploads/hero_local.png', 'local edit')
	await write(site, 'uploads/outside.png', 'outside')
	await fs.symlink(path.join(site, 'uploads/outside.png'), path.join(site, 'uploads/hero_local-dev-1.png'))
	await export_image()
	await prepare_dev_upload_export(site, exported, async (file, bytes) => fs.writeFile(file, bytes))
	assert.equal(await fs.readFile(path.join(site, 'uploads/hero_local.png'), 'utf8'), 'local edit')
	assert.equal(await fs.readFile(path.join(site, 'uploads/outside.png'), 'utf8'), 'outside')
	assert.equal(load(await fs.readFile(path.join(exported, 'site/content.yaml'), 'utf8')).favicon.upload, 'uploads/hero_local-dev-2.png')
})

test('malformed or unsafe response names cannot rewrite content', async t => {
	const { site, write } = await fixture(t)
	await write(site, 'uploads/hero.png', image)
	const yaml = 'favicon:\n  upload: unknown-id\n'
	await write(site, 'site/content.yaml', yaml)
	await preserve_upload_paths(site, { '../outside.png': { id: 'unknown-id', hash }, 'bad.png': null })
	assert.equal(await fs.readFile(path.join(site, 'site/content.yaml'), 'utf8'), yaml)
})

test('conflicting manifest identity is left unresolved instead of choosing another image', async t => {
	const { site, write } = await fixture(t)
	await write(site, 'uploads/a.png', 'first image')
	await write(site, 'uploads/b.png', 'second image')
	await write(site, 'uploads/.manifest.json', JSON.stringify({ 'a.png': { id: 'ambiguous-id' }, 'b.png': { id: 'ambiguous-id' } }))
	const yaml = 'favicon:\n  upload: ambiguous-id\n'
	await write(site, 'site/content.yaml', yaml)
	await preserve_upload_paths(site, {})
	assert.equal(await fs.readFile(path.join(site, 'site/content.yaml'), 'utf8'), yaml)
})
