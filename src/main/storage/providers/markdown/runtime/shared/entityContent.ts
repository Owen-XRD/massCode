import { assertEntityContentAvailable } from './cloudGuards'

interface EntityWithBodyContent {
  // null — ленивое тело, ещё не дочитанное из индекса метаданных.
  content: string | null
  pendingCloudDownload?: boolean
  updatedAt: number
}

interface OwnerWithNestedContent<TContent> {
  contents: TContent[]
  pendingCloudDownload?: boolean
  updatedAt: number
}

interface OwnerWithIdAndNestedContent<TContent>
  extends OwnerWithNestedContent<TContent> {
  id: number
}

type NestedContentOf<TOwner extends OwnerWithNestedContent<unknown>> =
  TOwner extends OwnerWithNestedContent<infer TContent> ? TContent : never

export function updateEntityBodyContent<
  TEntity extends EntityWithBodyContent,
>(input: {
  content: string
  entity: TEntity | undefined
  onAfterPersist?: () => void
  persistEntity: (entity: TEntity) => void
}): { notFound: boolean } {
  if (!input.entity) {
    return { notFound: true }
  }

  assertEntityContentAvailable(input.entity)

  const candidate = { ...input.entity, content: input.content, updatedAt: Date.now() }
  input.persistEntity(candidate)
  Object.assign(input.entity, candidate)
  input.onAfterPersist?.()

  return { notFound: false }
}

export function createNestedContent<
  TOwner extends OwnerWithNestedContent<unknown>,
>(input: {
  createContent: (id: number) => NestedContentOf<TOwner>
  nextContentId: () => number
  onOwnerNotFound: () => never
  owner: TOwner | undefined
  persistOwner: (owner: TOwner) => void
}): { id: number } {
  if (!input.owner) {
    input.onOwnerNotFound()
  }

  assertEntityContentAvailable(input.owner)

  const contentId = input.nextContentId()
  const candidate = {
    ...input.owner,
    contents: [...input.owner.contents, input.createContent(contentId)],
    updatedAt: Date.now(),
  }
  input.persistOwner(candidate)
  Object.assign(input.owner, candidate)

  return { id: contentId }
}

export function updateNestedContent<
  TOwner extends OwnerWithIdAndNestedContent<unknown>,
  TPatch,
>(input: {
  applyPatch: (content: NestedContentOf<TOwner>, patch: TPatch) => void
  findTargetOwnerById: (ownerId: number) => TOwner | undefined
  hasAnyField: (patch: TPatch) => boolean
  ownerId: number
  ownedContent:
    | {
      contentIndex: number
      owner: TOwner
    }
    | undefined
  patch: TPatch
  persistOwner: (owner: TOwner) => void
}): {
    invalidInput: boolean
    notFound: boolean
    parentNotFound: boolean
  } {
  if (!input.hasAnyField(input.patch)) {
    return {
      invalidInput: true,
      notFound: false,
      parentNotFound: false,
    }
  }

  if (!input.ownedContent) {
    return {
      invalidInput: false,
      notFound: true,
      parentNotFound: false,
    }
  }

  const { contentIndex, owner } = input.ownedContent

  assertEntityContentAvailable(owner)

  const candidate = { ...owner, contents: [...owner.contents] }
  const content = structuredClone(owner.contents[contentIndex]) as NestedContentOf<TOwner>
  candidate.contents[contentIndex] = content
  input.applyPatch(content, input.patch)

  let parentNotFound = false
  if (owner.id === input.ownerId) {
    candidate.updatedAt = Date.now()
    input.persistOwner(candidate)
    Object.assign(owner, candidate)
  }
  else {
    input.persistOwner(candidate)
    Object.assign(owner, candidate)

    const targetOwner = input.findTargetOwnerById(input.ownerId)
    if (targetOwner) {
      const targetCandidate = { ...targetOwner, updatedAt: Date.now() }
      input.persistOwner(targetCandidate)
      Object.assign(targetOwner, targetCandidate)
    }
    else {
      parentNotFound = true
    }
  }

  return {
    invalidInput: false,
    notFound: false,
    parentNotFound,
  }
}

export function deleteNestedContent<
  TOwner extends OwnerWithIdAndNestedContent<unknown>,
>(input: {
  ownedContent:
    | {
      contentIndex: number
      owner: TOwner
    }
    | undefined
  persistOwner: (owner: TOwner) => void
}): { deleted: boolean } {
  if (!input.ownedContent) {
    return { deleted: false }
  }

  const { contentIndex, owner } = input.ownedContent
  const candidate = {
    ...owner,
    contents: owner.contents.filter((_content, index) => index !== contentIndex),
    updatedAt: Date.now(),
  }
  input.persistOwner(candidate)
  Object.assign(owner, candidate)

  return { deleted: true }
}
