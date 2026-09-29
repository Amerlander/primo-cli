# Primo CLI

Local development CLI for [Primo](https://primo.build) - build and edit sites with a visual CMS.

## Installation

```bash
npm install -g primo-cli
```

## Quick Start

```bash
# Create a new site
primo new my-site

# This starts the local CMS automatically
# It scaffolds a workspace like:
# ./server.yaml
# ./library/
# ./sites/my-site/
```

## Commands

### `primo init [name]`

Initialize a new Primo workspace (server) in a new folder or the current directory.

```bash
primo init                   # Initialize in the current directory
primo init my-workspace      # Create and initialize "my-workspace"
```

### `primo new [name]`

Create a new site with starter files.

```bash
primo new                    # Interactive prompt for name
primo new my-site            # Create "sites/my-site" in the current workspace
primo new --skip-dev         # Create files without starting CMS
```

### `primo dev`

Start the local CMS server. Watches for file changes and syncs edits from the CMS back to local files.

```bash
primo dev                    # Start in current directory
primo dev -p 8080            # Use custom port
primo dev --author files     # Push file edits to the CMS; CMS UI is read-only (default)
primo dev --author cms       # CMS edits write to files; file edits revert
primo dev --author both      # Bidirectional sync (beta; CMS edits often lost on conflict)
```

The port comes from `--port`, then `port:` in the workspace's `server.yaml`, then 3000. Primo also reserves the next port for reload. If the default pair is occupied, it automatically chooses the next available pair and prints the URL. If you explicitly set a port, Primo asks before using another pair for the session; noninteractive runs fail with instructions to pass another `--port`.

The selected port is saved in `.primo/dev-server.json`, leaving `server.yaml` unchanged. Status, previews (CLI and MCP), new-site handling, and local pull discovery use this session record. A second dev server for the same workspace is refused to avoid opening its database twice. `--force` explicitly stops processes on the requested ports; automatic fallback never stops them.

### `primo push`

Sync local changes to an existing hosted Primo server. Requires a server you've
already deployed (run `primo deploy` first) and authenticated against (`primo
login -s <server-url>`).

```bash
primo push https://cms.example.com --site abc123
primo push --only my-site    # Push just one site folder (workspace root)
primo push --preview         # Preview changes without applying
primo push --dry-run         # Show what would be sent without making requests
```

Options:
- `-s, --server <url>` - Server URL
- `--site <id>` - Site ID
- `--only <slug>` - Push only the named site folder under `sites/` (skips library)
- `-d, --dir <dir>` - Directory (default: `.`)
- `-t, --token <token>` - Auth token
- `--preview` - Preview only
- `--dry-run` - Show what would be pushed without sending requests

### `primo pull`

Pull an entire hosted Primo server — all sites plus the shared library — to local files.

```bash
primo pull https://cms.example.com
primo pull https://cms.example.com -o ./my-workspace
```

Options:
- `-s, --server <url>` - Server URL (auto-detects local)
- `-o, --output <dir>` - Output directory (defaults to `./<server-hostname>`)
- `-t, --token <token>` - Auth token

### `primo library pull`

Pull the shared block library into a workspace root.

```bash
primo library pull https://cms.example.com
primo library pull -o ./my-workspace
```

Options:
- `-s, --server <url>` - Server URL (auto-detects local)
- `-o, --output <dir>` - Workspace output directory (default: `.`)
- `-t, --token <token>` - Auth token

### `primo library push`

Push the local shared block library back to a hosted Primo instance.

```bash
primo library push https://cms.example.com
primo library push https://cms.example.com -d ./my-workspace
```

Options:
- `-s, --server <url>` - Server URL
- `-d, --dir <dir>` - Workspace directory containing `library/` (default: `.`)
- `-t, --token <token>` - Auth token

### `primo login`

Authenticate with a hosted Primo instance.

```bash
primo login https://cms.example.com
primo login https://cms.example.com -e user@example.com
```

### `primo deploy`

Deploy the entire workspace — all sites under `sites/`, plus `library/` and
`server.yaml` — as one editable-CMS unit, to Railway or Fly.io. Must be run
from the workspace root (the directory containing `server.yaml`).

```bash
primo deploy                 # Interactive provider selection
primo deploy -p railway      # Deploy to Railway
primo deploy -p fly          # Deploy to Fly.io
primo deploy --dry-run       # Show what would be deployed without doing anything
```

For other hosts (Netlify, Vercel, Cloudflare, GitHub Pages), use `primo build`
on a single site and deploy the output folder with that host's CLI.

#### Picking the right "going-live" command

| You want to…                                  | Use            |
| --------------------------------------------- | -------------- |
| Let collaborators edit content from a CMS UI  | `primo deploy` |
| Ship a static site to any static host         | `primo build`  |
| Sync local edits to an existing hosted server | `primo push`   |

### `primo validate`

Check site structure for errors.

```bash
primo validate
primo validate --strict      # Strict mode
```

### `primo build`

Build static HTML site for deployment to any static host.

```bash
primo build                  # Output to ./dist
primo build -o ./public      # Custom output directory
```

Deploy the output anywhere:
```bash
# Netlify
npx netlify deploy --prod --dir=dist

# Vercel
npx vercel dist

# Cloudflare Pages
npx wrangler pages deploy dist

# Or just push to a repo connected to any static host
```

## Connect your agent

Give an MCP-capable coding agent (Claude Code, Claude Desktop, Cursor, VS Code / Copilot, Codex,
OpenCode, Gemini CLI, Cline, Windsurf, Continue, Zed) direct access to Primo
tools. The server is the official [`primo-mcp`](https://www.npmjs.com/package/primo-mcp)
stdio server; install it globally for the direct command, or let the CLI fall
back to `npx -y primo-mcp`.

```bash
npm install -g primo-mcp     # recommended prerequisite

primo mcp install            # detect clients and merge the Primo entry
primo mcp install --dry-run  # show the target paths and what would change
primo mcp install --client cursor --client vscode
primo mcp install --all --global
primo mcp list               # what's detected, configured, and where
primo mcp print --client opencode   # paste it yourself
```

`install` merges only the `primo` entry: existing settings, sibling servers and
comments are preserved. Every write backs up the file first
(`<file>.bak-<timestamp>`) and is atomic. Re-running is idempotent, `--dry-run`
writes nothing, and a conflicting `primo` entry is left in place unless you pass
`--force`. Files with JSONC comments that can't be preserved are never rewritten
— `primo mcp print` emits the snippet instead.

MCP is optional. `primo validate` and `primo build` work without it.

## Site Structure

```
workspace/
├── server.yaml
├── library/
└── sites/
    └── my-site/
        ├── site.yaml
        ├── blocks/
        ├── pages/
        ├── page-types/
        └── site/
```

## Multiple Sites

Run `primo dev` from a workspace folder to work on multiple sites at once:

```
workspace/
├── server.yaml         # Optional: port + site_groups
└── sites/
    ├── site-one/
    │   └── site.yaml   # includes group: default
    └── site-two/
        └── site.yaml   # includes group: default
```

Each site gets its own subdomain: `site-one.localhost:3000`, `site-two.localhost:3000`

## Shared Library Workspace

The shared block library can live at the workspace root alongside the `sites/` folder:

```text
workspace/
├── server.yaml
├── library/
│   ├── marketing/
│   │   └── hero/
│   └── shared/
│       └── footer/
└── sites/
    ├── site-one/
    └── site-two/
```

## Documentation

Full documentation: [docs.primo.build](https://docs.primo.build)

## Requirements

- Node.js 18+
- For `primo deploy`: Railway CLI or Fly.io CLI
