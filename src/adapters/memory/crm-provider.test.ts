import { describeCrmProvider } from '~/ports/crm-provider.behaviour'
import { createMemoryCrmProvider } from './crm-provider'

describeCrmProvider('memory', () => {
  const provider = createMemoryCrmProvider()
  return { provider, acceptCode: (code, grant) => provider.acceptCode(code, grant) }
})
