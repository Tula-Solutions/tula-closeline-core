import type {
  BookingTypeId,
  CompanySizeBand,
  RoutingAttributes,
  RoutingConditions,
} from 'tula-closeline-contract'

/** The company size band an employee count falls in, or `null` for a count below 1. */
export function bandOf(employeeCount: number): CompanySizeBand | null {
  if (!Number.isFinite(employeeCount) || employeeCount < 1) {
    return null
  }
  const bands: [number, CompanySizeBand][] = [
    [10, '1-10'],
    [50, '11-50'],
    [200, '51-200'],
    [1000, '201-1000'],
    [5000, '1001-5000'],
  ]
  return bands.find(([upTo]) => employeeCount <= upTo)?.[1] ?? '5001+'
}

/** Whether a value is in a condition list; a missing list matches anything, a missing value matches no list. */
const within = <T>(list: readonly T[] | undefined, value: T | null | undefined): boolean =>
  list === undefined || (value !== null && value !== undefined && list.includes(value))

/** Whether a rule's conditions all hold for a Prospect's attributes and the Booking Type asked for. */
export function matches(
  conditions: RoutingConditions,
  attributes: RoutingAttributes,
  bookingTypeId: BookingTypeId | undefined
): boolean {
  return (
    within(conditions.countries, attributes.country) &&
    within(conditions.regions, attributes.region) &&
    within(conditions.companySizeBands, attributes.companySizeBand) &&
    within(conditions.accountOwnerMembershipIds, attributes.accountOwnerMembershipId) &&
    within(conditions.sources, attributes.source) &&
    within(conditions.bookingTypeIds, bookingTypeId)
  )
}

/** Whether a rule has no conditions at all, which makes it the default rule. */
export const isDefaultRule = (conditions: RoutingConditions): boolean =>
  Object.values(conditions).every((value) => value === undefined)
