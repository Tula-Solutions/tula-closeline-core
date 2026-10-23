import { describeSecretBox } from '~/ports/secret-box.behaviour'
import { createMemorySecretBox } from './secret-box'

describeSecretBox('memory', () => createMemorySecretBox())
