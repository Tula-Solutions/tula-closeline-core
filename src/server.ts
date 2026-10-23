import { createApp } from '~/app'
import { createContainer } from '~/container'
import { serveOptions } from '~/http/serve'
import { startDemoBackground } from '~/modules/demo-request/worker'
import { startAssignWorker } from '~/modules/prospect/assign-worker'
import { shutdown } from '~/shutdown'

const container = createContainer()
const app = createApp(container)
const server = Bun.serve(serveOptions(container, app))
const background = new AbortController()
void startDemoBackground(container, background.signal)
void startAssignWorker(container, background.signal)

container.logger.info('listening', { port: server.port, environment: container.env.ENVIRONMENT })

function stop(signal: string): void {
  background.abort()
  void shutdown({
    signal,
    server,
    lifecycle: container.lifecycle,
    clock: container.clock,
    logger: container.logger,
    graceMs: container.env.SHUTDOWN_GRACE_MS,
    timeoutMs: container.env.SHUTDOWN_TIMEOUT_MS,
    // A clean stop releases the database connections first; a failed or forced one exits at once.
    exit: (code) => {
      if (code !== 0) {
        process.exit(code)
      }
      container.close().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    },
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
