import { expect, test } from 'bun:test'
import { describeError, MAX_LOGGED_MESSAGE } from './describe-error'

test('an error is described by name, message, stack frames and its cause chain', () => {
  const root = new TypeError('socket closed')
  const error = new Error('query failed', { cause: new Error('driver failed', { cause: root }) })

  const described = describeError(error)

  expect(described).toMatchObject({
    name: 'Error',
    message: 'query failed',
    cause: { name: 'Error', message: 'driver failed', cause: { name: 'TypeError' } },
  })
  expect(JSON.stringify(described)).toContain('describe-error.test.ts')
})

test('a long message is cut to a bounded length', () => {
  const described = describeError(new Error('x'.repeat(10_000)))

  expect(String(described.message)).toHaveLength(MAX_LOGGED_MESSAGE)
})

test('the stack carries frames only, so the full message is not repeated through it', () => {
  const described = describeError(new Error(`secret-${'y'.repeat(500)}`))

  expect(JSON.stringify(described.stack)).not.toContain('secret-')
})

test('an error without a stack is described without frames', () => {
  const error = new Error('no stack')
  error.stack = undefined

  expect(describeError(error)).toMatchObject({ message: 'no stack', stack: [] })
})

test('a cyclic cause chain is cut off', () => {
  const a = new Error('a')
  const b = new Error('b', { cause: a })
  a.cause = b

  expect(JSON.stringify(describeError(a)).length).toBeLessThan(20_000)
})

test.each([['text'], [42], [undefined], [{ token: 'abc' }]])(
  'a non-Error value (%p) is described by its type only',
  (value) => {
    const described = describeError(value)

    expect(described).toEqual({ name: 'NonError', type: typeof value })
  }
)
