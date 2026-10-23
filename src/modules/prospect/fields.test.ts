import { describe, expect, test } from 'bun:test'
import { formatId, type ProspectId } from 'tula-closeline-contract'
import { createMemoryCoreStore } from '~/adapters/memory/core-store'
import { seedOrganization } from '~/testing'
import { writeFields } from './fields'

const NOW = new Date('2026-02-01T00:00:00Z')
const LATER = new Date('2026-03-01T00:00:00Z')

async function setup() {
  const store = createMemoryCoreStore()
  const seeded = await seedOrganization(store)
  const id = formatId('prs', crypto.randomUUID()) as ProspectId
  await store.withOrganization(seeded.organizationId, async (scope) => {
    await scope.lockOrganization()
    await scope.insertProspect({
      id,
      companyId: null,
      ownerMembershipId: null,
      source: 'import',
      tags: [],
      notes: null,
      now: NOW,
    })
  })
  const write = (
    source: string,
    fields: Record<string, string | null>,
    at = NOW,
    userId = source === 'manual' ? seeded.owner.userId : null,
    sourceAt?: Date
  ) =>
    store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      return writeFields(
        scope,
        'prospect',
        id,
        Object.entries(fields).map(([field, value]) => ({
          field,
          value,
          source,
          sourceRef: source === 'manual' ? null : 'file-1',
          ...(sourceAt ? { at: sourceAt } : {}),
        })),
        { userId, at }
      )
    })
  const current = async (field: string) => {
    const map = await store.withOrganization(seeded.organizationId, (scope) =>
      scope.listCurrentFields('prospect', [id])
    )
    return (map.get(id) ?? []).find((r) => r.field === field)
  }
  return { store, seeded, id, write, current }
}

describe('writeFields precedence (ADR 0020)', () => {
  test('a Source time in the future is clamped, so it cannot block later imports', async () => {
    const { write, current } = await setup()
    await write('import', { jobTitle: 'First' }, NOW, null, new Date('2099-01-01T00:00:00Z'))
    expect((await current('jobTitle'))?.setAt).toEqual(NOW)
    await write('import', { jobTitle: 'Second' }, LATER, null, LATER)
    expect((await current('jobTitle'))?.value).toBe('Second')
  })

  test('a late import that is older than the held value does not replace it', async () => {
    const { write, current } = await setup()
    await write('import', { jobTitle: 'New' }, LATER, null, LATER)
    await write('import', { jobTitle: 'Old' }, LATER, null, NOW)
    expect((await current('jobTitle'))?.value).toBe('New')
    expect((await current('jobTitle'))?.setAt).toEqual(LATER)
  })

  test('a manual edit survives a later import of a different value', async () => {
    const { write, current } = await setup()
    await write('import', { jobTitle: 'Engineer' })
    await write('manual', { jobTitle: 'CTO' })

    const result = await write('import', { jobTitle: 'Developer' }, LATER)

    expect(result.changedFields).toEqual([])
    expect(await current('jobTitle')).toMatchObject({ value: 'CTO', source: 'manual' })
  })

  test('a newer import replaces an older import and reports the change', async () => {
    const { write, current } = await setup()
    await write('import', { jobTitle: 'Engineer' })

    const result = await write('import', { jobTitle: 'Developer' }, LATER)

    expect(result.changedFields).toEqual(['jobTitle'])
    expect(await current('jobTitle')).toMatchObject({
      value: 'Developer',
      source: 'import',
      sourceRef: 'file-1',
      setAt: LATER,
    })
  })

  test('an enrichment does not replace an import', async () => {
    const { write, current } = await setup()
    await write('import', { jobTitle: 'Engineer' })

    const result = await write('enrichment:apollo', { jobTitle: 'Staff Engineer' }, LATER)

    expect(result.changedFields).toEqual([])
    expect(await current('jobTitle')).toMatchObject({ value: 'Engineer', source: 'import' })
  })

  test('the same value again reports no change', async () => {
    const { write } = await setup()
    await write('import', { jobTitle: 'Engineer' })

    expect((await write('import', { jobTitle: 'Engineer' }, LATER)).changedFields).toEqual([])
  })

  test('only a manual write clears a field', async () => {
    const { write, current } = await setup()
    await write('import', { jobTitle: 'Engineer' })

    expect((await write('import', { jobTitle: null }, LATER)).changedFields).toEqual([])
    expect(await current('jobTitle')).toBeDefined()
    expect((await write('manual', { jobTitle: null }, LATER)).changedFields).toEqual(['jobTitle'])
    expect(await current('jobTitle')).toBeUndefined()
  })

  test('an email written keeps the identity in step, so a clash is refused', async () => {
    const { write, store, seeded } = await setup()
    await write('import', { email: 'a@example.test' })
    const other = formatId('prs', crypto.randomUUID()) as ProspectId
    await store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      await scope.insertProspect({
        id: other,
        companyId: null,
        ownerMembershipId: null,
        source: 'import',
        tags: [],
        notes: null,
        now: NOW,
      })
    })

    const clash = store.withOrganization(seeded.organizationId, async (scope) => {
      await scope.lockOrganization()
      return writeFields(
        scope,
        'prospect',
        other,
        [{ field: 'email', value: 'a@example.test', source: 'import', sourceRef: 'f' }],
        { userId: null, at: NOW }
      )
    })

    await expect(clash).rejects.toThrow()
  })
})
