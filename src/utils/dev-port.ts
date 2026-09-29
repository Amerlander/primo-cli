import net from 'net'

export function requested_dev_port(flag?: string, configured?: number): { port: number; explicit: boolean } {
	const value = flag !== undefined ? flag : configured ?? 3000
	const port = Number(value)
	if ((typeof value === 'string' && !/^\d+$/.test(value)) || !Number.isInteger(port) || port < 1 || port > 65534) {
		throw new Error('Port must be an integer between 1 and 65534 (the next port is reserved for reload).')
	}
	return { port, explicit: flag !== undefined || configured !== undefined }
}

// Binding detects any listener, including non-HTTP apps and unhealthy servers.
export async function is_port_in_use(port: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer()
		probe.once('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'EADDRINUSE') resolve(true)
			else reject(error)
		})
		probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)))
	})
}

export async function select_dev_port(options: {
	port: number
	explicit: boolean
	confirm?: (next: number) => Promise<boolean>
}): Promise<number> {
	const { port, explicit, confirm } = options
	if (!await is_port_in_use(port) && !await is_port_in_use(port + 1)) return port
	if (explicit && !confirm) {
		throw new Error(`Port ${port} or reload port ${port + 1} is in use. Choose another pair with --port <port>, or explicitly use --force to stop the existing processes.`)
	}
	for (let next = port + 1; next <= 65534; next++) {
		if (await is_port_in_use(next) || await is_port_in_use(next + 1)) continue
		if (explicit && !await confirm!(next)) throw new Error('Server startup cancelled; configured port unchanged.')
		return next
	}
	throw new Error(`No available port pair found above ${port}. Choose a lower port with --port <port>.`)
}
