import { expect, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import { AppError } from 'tula-closeline-kit'
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

test('message lines that look like stack frames never reach the stack field', () => {
  const described = describeError(
    new Error(
      `first line\nat ${'x'.repeat(300)} password=hunter2\nat other (secret.ts:1:1)\nat z (a.ts:1:1)`
    )
  )

  const text = JSON.stringify(described)
  expect(text).not.toContain('hunter2')
  expect(text).not.toContain('secret.ts')
  expect(text.length).toBeLessThan(5_000)
  expect(JSON.stringify(described.stack)).toContain('describe-error.test.ts')
})

test('each frame and the number of frames are bounded', () => {
  const error = new Error('deep')
  error.stack = ['Error: deep']
    .concat(
      Array.from({ length: 100 }, (_, i) => `    at fn${i} (/${'p'.repeat(2_000)}/file.ts:${i}:1)`)
    )
    .join('\n')

  const stack = describeError(error).stack as string[]

  expect(stack.length).toBeLessThanOrEqual(12)
  for (const frame of stack) {
    expect(frame.length).toBeLessThanOrEqual(300)
  }
})

test('lines in a stack that are not frames are dropped', () => {
  const error = new Error('plain')
  error.stack = 'Error: plain\n    at fn (file.ts:1:2)\n    at password=hunter2\n    at <anonymous>'

  expect(describeError(error).stack).toEqual(['at fn (file.ts:1:2)'])
})

test('an error with a status and a code carries both', () => {
  const described = describeError(
    new AppError({ code: 'billing.vendor_down', status: 503, message: 'Vendor is down.' })
  )

  expect(described).toMatchObject({ name: 'AppError', status: 503, code: 'billing.vendor_down' })
})

test('an HTTPException without a name is described as HTTPException, with its status', () => {
  const described = describeError(new HTTPException(502))

  expect(described).toMatchObject({ name: 'HTTPException', status: 502 })
  expect(described).not.toHaveProperty('code')
})

test('a plain Error has neither status nor code', () => {
  const described = describeError(new Error('x'))

  expect(described).not.toHaveProperty('status')
  expect(described).not.toHaveProperty('code')
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
