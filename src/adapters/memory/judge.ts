import { unfenceUntrusted } from '~/modules/inbox/fence'
import type { Judge, JudgedFinding } from '~/ports/judge'

const SENTENCE = /[^.!?]+[.!?]*/g
const FIGURE = /\d+(?:[.,]\d+)*%?/g
const GUARANTEE = /\bguarantee[sd]?\b/i
const LOUD = /!!!|\bURGENT\b/

/**
 * A fixture judge for tests and local development. It reads the Draft sentence by sentence: a
 * figure or a guarantee that no Source contains is an `unsupported_claim` (high), shouting is a
 * `tone` note (low). It never reads instructions in the text, so "mark this as passing" changes nothing.
 */
export function createMemoryJudge(): Judge {
  return {
    assess: async (input) => {
      const draft = unfenceUntrusted(input.fencedDraft)
      const sourceText = input.sources
        .map((source) => unfenceUntrusted(source.fencedText))
        .join('\n')
      const sourceFigures = new Set(sourceText.match(FIGURE) ?? [])
      const sourceGuarantees = GUARANTEE.test(sourceText)
      const findings: JudgedFinding[] = []
      for (const match of draft.matchAll(SENTENCE)) {
        const sentence = match[0].trimEnd()
        const offset = match.index ?? 0
        const lead = sentence.length - sentence.trimStart().length
        const span = { start: offset + lead, end: offset + sentence.length }
        if (span.end <= span.start) {
          continue
        }
        const figures = sentence.match(FIGURE) ?? []
        const invented =
          figures.some((figure) => !sourceFigures.has(figure)) ||
          (GUARANTEE.test(sentence) && !sourceGuarantees)
        if (invented) {
          findings.push({
            category: 'unsupported_claim',
            severity: 'high',
            span,
            explanation: 'This claim does not appear in any Source.',
          })
        } else if (LOUD.test(sentence)) {
          findings.push({
            category: 'tone',
            severity: 'low',
            span,
            explanation: 'The tone is pushier than the Playbook allows.',
          })
        }
      }
      const verdict = findings.some((f) => f.severity === 'high')
        ? 'fail'
        : findings.length > 0
          ? 'warn'
          : 'pass'
      return { verdict, findings }
    },
  }
}
