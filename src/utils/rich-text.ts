import MarkdownIt from 'markdown-it'
import { getSchema, type JSONContent } from '@tiptap/core'
import { DOMSerializer, Node, type Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Youtube from '@tiptap/extension-youtube'
import Highlight from '@tiptap/extension-highlight'

// Converts `markdown` and `rich-text` field values to the HTML blocks receive,
// mirroring the CMS (convert_markdown_to_html / convert_rich_text_to_html in
// its builder utils). Same markdown-it options and the same tiptap schema;
// Typography is left out because it only adds input rules, not markup.
// Fenced code is escaped, not syntax-highlighted (the CMS uses highlight.js).

let markdown_renderer: MarkdownIt | undefined
let rich_text_schema: Schema | undefined

export function markdown_to_html(markdown: string): string {
	markdown_renderer ??= new MarkdownIt({
		html: true,
		linkify: true,
		typographer: true,
		highlight: (code) => `<pre><code class="hljs">${markdown_renderer!.utils.escapeHtml(code)}</code></pre>`
	})
	try {
		return markdown_renderer.render(markdown)
	} catch {
		return ''
	}
}

// Rich text is stored as tiptap JSON; a string is treated as markdown, as
// the CMS does. Unrenderable values become '' instead of "[object Object]".
export function rich_text_to_html(value: unknown): string {
	if (typeof value === 'string') return markdown_to_html(value)
	if (!value || typeof value !== 'object') return ''
	try {
		rich_text_schema ??= getSchema([
			StarterKit.configure({ link: { openOnClick: false } }),
			Image,
			Youtube.configure({ modestBranding: true }),
			Highlight.configure({ multicolor: false })
		])
		const doc = Node.fromJSON(rich_text_schema, value as JSONContent)
		const options = { document: html_document } as unknown as Parameters<DOMSerializer['serializeFragment']>[1]
		const fragment = DOMSerializer.fromSchema(rich_text_schema).serializeFragment(doc.content, options)
		return serialize(fragment as unknown as HtmlNode)
	} catch {
		return ''
	}
}

// ProseMirror's serializer only needs to create nodes, set attributes and
// append children, so a tiny in-memory document stands in for a DOM. Its
// output follows the HTML serialization a browser's innerHTML produces.
interface HtmlNode {
	tag?: string
	text?: string
	attributes: Array<[string, string]>
	children: HtmlNode[]
	setAttribute(name: string, value: unknown): void
	appendChild(child: HtmlNode): HtmlNode
}

function html_node(props: { tag?: string; text?: string }): HtmlNode {
	return {
		...props,
		attributes: [],
		children: [],
		setAttribute(name, value) {
			this.attributes = this.attributes.filter(([existing]) => existing !== name)
			this.attributes.push([name, String(value)])
		},
		appendChild(child) {
			this.children.push(child)
			return child
		}
	}
}

const html_document = {
	createElement: (tag: string) => html_node({ tag: tag.toLowerCase() }),
	createElementNS: (_namespace: string, tag: string) => html_node({ tag }),
	createTextNode: (text: string) => html_node({ text }),
	createDocumentFragment: () => html_node({})
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

function serialize(node: HtmlNode): string {
	if (node.text !== undefined) {
		return node.text.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	}
	const children = node.children.map(serialize).join('')
	if (!node.tag) return children
	const attributes = node.attributes
		.map(([name, value]) => ` ${name}="${value.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/"/g, '&quot;')}"`)
		.join('')
	return VOID_ELEMENTS.has(node.tag) ? `<${node.tag}${attributes}>` : `<${node.tag}${attributes}>${children}</${node.tag}>`
}
