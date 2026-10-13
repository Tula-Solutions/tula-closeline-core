import { expect, test } from 'bun:test'
import { drain } from './shutdown'

function fakeServer(finishesAfterMs: number | null) {
  const calls: (boolean | undefined)[] = []
  return {
    calls,
    stop: (force?: boolean) => {
      calls.push(force)
      if (force || finishesAfterMs === 0) {
        return Promise.resolve()
      }
      // A stuck request: graceful stop never settles unless it is allowed to finish.
      return finishesAfterMs === null
        ? new Promise<void>(() => {})
        : new Promise<void>((resolve) => setTimeout(resolve, finishesAfterMs))
    },
  }
}

test('drain waits for in-flight requests and does not force-close when they finish in time', async () => {
  const server = fakeServer(10)

  expect(await drain(server, 1_000)).toBe('drained')
  expect(server.calls).toEqual([undefined])
})

test('drain force-closes what is still running after the timeout', async () => {
  const server = fakeServer(null)

  expect(await drain(server, 20)).toBe('forced')
  expect(server.calls).toEqual([undefined, true])
})
