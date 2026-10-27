import type { CallId, CitationRef, OrganizationId } from 'tula-closeline-contract'

/** The words of one Agent turn and what it rested on, read from the Call's Transcript for checking. */
export type TurnText = {
  /** What the Prospect said just before the turn. */
  prospectText: string
  /** What the Agent said in the turn. */
  agentText: string
  /** The cited Playbook sources, with their text. */
  sources: { id: string; prospect: string; repNext: string }[]
}

/**
 * Reads the text of a Call turn from the service that holds the Transcript. The `call.turn_completed`
 * event carries no text, so the check asks for it here. It throws when the Transcript cannot be
 * reached or `signal` aborts, and answers `null` when the turn has no text (then it is not assessed).
 */
export interface TurnReader {
  /** Reads one turn; aborts when `signal` does. */
  read(
    input: {
      organizationId: OrganizationId
      callId: CallId
      turnIndex: number
      citedSources: CitationRef[]
    },
    signal: AbortSignal
  ): Promise<TurnText | null>
}
