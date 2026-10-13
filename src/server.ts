import { createApp } from '~/app'
import { createContainer } from '~/container'
import { drain } from '~/shutdown'

const container = createContainer()
const server = Bun.serve({ port: container.env.PORT, fetch: createApp(container).fetch })

container.logger.info('listening', { port: server.port, environment: container.env.ENVIRONMENT })

let stopping = false

async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    return
  }
  stopping = true
  container.logger.info('shutting down', { signal })
  const result = await drain(server, container.env.SHUTDOWN_TIMEOUT_MS)
  container.logger.info('stopped', { result })
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
