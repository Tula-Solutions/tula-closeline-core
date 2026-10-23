import {
  claimDemoNotices,
  type Database,
  purgeDemoRequests,
  settleDemoNotice,
  submitDemoRequest,
} from 'tula-closeline-db'
import type { DemoRequestStore } from '~/ports/demo-request-store'

/**
 * The Demo Request store over Postgres: four calls to the `core.*_demo_*` functions on the pooled
 * handle (the table has no Organization, and `closeline_core` has no direct access to it). A
 * refused field surfaces as the db package's `DemoRequestRefusedError`, which holds a SQLSTATE and
 * a constraint name and no Visitor field.
 */
export function createPostgresDemoRequestStore(db: Pick<Database, 'execute'>): DemoRequestStore {
  return {
    submit: (input) => submitDemoRequest(db, input),
    claimNotices: (limit, backoffSeconds) => claimDemoNotices(db, limit, backoffSeconds),
    settleNotice: (id, outcome) => settleDemoNotice(db, id, outcome),
    purgeExpired: (limit) => purgeDemoRequests(db, limit),
  }
}
