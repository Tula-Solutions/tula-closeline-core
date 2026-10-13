import { describeCoreStore } from '~/ports/core-store.behaviour'
import { createMemoryCoreStore } from './core-store'

describeCoreStore('memory', async () => {
  const store = createMemoryCoreStore()
  return { store, setStatus: async (id, status) => store.setOrganizationStatus(id, status) }
})
