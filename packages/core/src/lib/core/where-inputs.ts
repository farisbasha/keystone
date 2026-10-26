import type { DBField, KeystoneContext } from '../../types/index.ts'
import type { PrismaFilter, UniquePrismaFilter } from '../../types/prisma.ts'
import { getAccessFilters, getOperationQueryAccess } from './access-control.ts'
import { userInputError } from './graphql-errors.ts'
import type { InitialisedList } from './initialise-lists.ts'
import { getDBFieldKeyForFieldOnMultiField } from './utils.ts'

export type InputFilter = Record<string, any> & {
  _____?: 'input filter'
  AND?: InputFilter[]
  OR?: InputFilter[]
  NOT?: InputFilter[]
}

export type UniqueInputFilter = Record<string, any> & { _____?: 'unique input filter' }

export async function resolveUniqueWhereInput(
  inputFilter: UniqueInputFilter,
  list: InitialisedList,
  context: KeystoneContext
): Promise<UniquePrismaFilter> {
  const where: UniquePrismaFilter = {}
  for (const key in inputFilter) {
    const value = inputFilter[key]

    const resolver = list.fields[key].input!.uniqueWhere!.resolve
    if (resolver !== undefined) {
      where[key] = await resolver(value, context)
    } else {
      where[key] = value
    }
  }

  return where
}

// caches relationship filter access by list key while resolving a single filter, so a related
// list's access functions run once rather than once per occurrence in the filter.
// a cache is only used with one kind: non-unique filters use many, unique selectors use one
export type RelationshipFilterAccessCache = Map<string, Promise<RelationshipFilterAccess>>

// true: every related item is accessible
// false: no related item is accessible, so relationship filters can be decided without a subquery
// a filter: only related items matching it are accessible
export type RelationshipFilterAccess = boolean | PrismaFilter

export function getRelationshipFilterAccess(
  list: InitialisedList,
  context: KeystoneContext,
  kind: 'one' | 'many',
  cache: RelationshipFilterAccessCache
): Promise<RelationshipFilterAccess> {
  let access = cache.get(list.listKey)
  if (!access) {
    access = resolveRelationshipFilterAccess(list, context, kind)
    cache.set(list.listKey, access)
  }
  return access
}

async function resolveRelationshipFilterAccess(
  list: InitialisedList,
  context: KeystoneContext,
  kind: 'one' | 'many'
): Promise<RelationshipFilterAccess> {
  // denied operation access is treated the same as an access filter returning false:
  // the related items are inaccessible, so the relationship filter matches as if there were none
  if (!(await getOperationQueryAccess(list, context, kind))) return false
  const access = await getAccessFilters(list, context, 'query', kind)
  if (typeof access === 'boolean') return access
  return resolveAccessFilterWhereInput(access, list, context)
}

export function applyRelationshipFilterAccess(
  where: PrismaFilter,
  access: true | PrismaFilter
): PrismaFilter {
  if (access === true) return where
  return { AND: [access, where] }
}

// resolves a user-supplied filter, applying relationship filter access control
export function resolveWhereInput(
  inputFilter: InputFilter,
  list: InitialisedList,
  context: KeystoneContext
): Promise<PrismaFilter> {
  return resolveWhereInputWithAccess(inputFilter, list, context, new Map())
}

// Access filters are trusted configuration: relationships in them do not apply relationship
// filter access control, which would otherwise recurse into the related list's access filters
export function resolveAccessFilterWhereInput(
  inputFilter: InputFilter,
  list: InitialisedList,
  context: KeystoneContext
): Promise<PrismaFilter> {
  return resolveWhereInputWithAccess(inputFilter, list, context, null)
}

async function resolveWhereInputWithAccess(
  inputFilter: InputFilter,
  list: InitialisedList,
  context: KeystoneContext,
  // null skips relationship filter access control
  relationshipAccess: RelationshipFilterAccessCache | null
): Promise<PrismaFilter> {
  return {
    AND: await Promise.all(
      Object.entries(inputFilter).map(async ([key, value]) => {
        if (key === 'OR' || key === 'AND' || key === 'NOT') {
          return {
            [key]: await Promise.all(
              value.map((value: any) =>
                resolveWhereInputWithAccess(value, list, context, relationshipAccess)
              )
            ),
          }
        }

        // we know if there are filters in the input object with the key of a field,
        //   the field must have defined a where input so this non null assertion is okay
        const field = list.fields[key]
        const { dbField } = field

        const resolve = field.input!.where!.resolve
        const ret = resolve
          ? await resolve(
              value,
              context,
              (() => {
                if (dbField.kind !== 'relation') {
                  return undefined as any
                }
                const foreignList = list.lists[dbField.list]
                const whereResolver = (filter: InputFilter) =>
                  resolveWhereInputWithAccess(filter, foreignList, context, relationshipAccess)

                if (dbField.mode === 'many') {
                  return async () => {
                    if (value === null) {
                      throw userInputError('A many relation filter cannot be set to null')
                    }
                    const access = relationshipAccess
                      ? await getRelationshipFilterAccess(
                          foreignList,
                          context,
                          'many',
                          relationshipAccess
                        )
                      : true
                    const entries = Object.entries(value)
                    for (const [key, val] of entries) {
                      if (val === null) {
                        throw userInputError(
                          `The key "${key}" in a many relation filter cannot be set to null`
                        )
                      }
                    }
                    if (access === false) {
                      // with no accessible related items, some never matches while none and every always match
                      return !Object.hasOwn(value, 'some')
                    }
                    return {
                      AND: await Promise.all(
                        entries.map(async ([key, val]) => {
                          const where = await whereResolver(val as any)
                          if (key === 'every' && access !== true) {
                            // Every visible item matches iff no visible item fails.
                            // Keep an explicit tautology: Prisma drops empty objects
                            // inside NOT, which would make every: {} reject items.
                            return {
                              none: applyRelationshipFilterAccess(
                                { NOT: { AND: [{ id: { notIn: [] } }, where] } },
                                access
                              ),
                            }
                          }
                          return { [key]: applyRelationshipFilterAccess(where, access) }
                        })
                      ),
                    }
                  }
                }

                return async (value: any) => {
                  const access = relationshipAccess
                    ? await getRelationshipFilterAccess(
                        foreignList,
                        context,
                        'many',
                        relationshipAccess
                      )
                    : true
                  if (access === false) {
                    // with no accessible related item, it always matches null and never matches a filter
                    return value === null
                  }
                  if (value === null) return access === true ? null : { isNot: access }
                  return { is: applyRelationshipFilterAccess(await whereResolver(value), access) }
                }
              })()
            )
          : value
        // relationship filter resolvers return a boolean when the related list is inaccessible,
        // which decides the filter on this list rather than the relationship field
        if (ret === true) return {}
        if (ret === false) return { id: { in: [] } }
        if (ret === null) {
          if (dbField.kind === 'multi') {
            // Note: no built-in field types support multi valued database fields *and* filtering.
            // This code path is only relevent to custom fields which fit that criteria.
            throw new Error('multi db fields cannot return null from where input resolvers')
          }
          return { [key]: null }
        }
        return handleOperators(key, dbField, ret)
      })
    ),
  }
}

function handleOperators(fieldKey: string, dbField: DBField, { AND, OR, NOT, ...rest }: any) {
  return {
    AND: AND?.map((value: any) => handleOperators(fieldKey, dbField, value)),
    OR: OR?.map((value: any) => handleOperators(fieldKey, dbField, value)),
    NOT: NOT?.map((value: any) => handleOperators(fieldKey, dbField, value)),
    ...nestWithAppropiateField(fieldKey, dbField, rest),
  }
}

function nestWithAppropiateField(fieldKey: string, dbField: DBField, value: any) {
  if (dbField.kind === 'multi') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        getDBFieldKeyForFieldOnMultiField(fieldKey, key),
        val,
      ])
    )
  }
  return { [fieldKey]: value }
}
