import { lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-session-delete-live'
export const inject = ['connection', 'agents', 'sessions', 'sessionController', 'sessionPersistence']

const ROUTE = '/api/session-delete'
const EFFECT = Symbol.for('cordis.effect')

function failure(code) {
  return { ok: false, error: { code } }
}

function liveSession(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) return {}

  const agent = ctx.agents.get(sessionId)
  if (agent?.session !== session || session.header.origin === 'subagent') return { reason: 'session-live' }
  if (agent.status !== 'idle') return { reason: 'session-running' }

  // DSH 0.2.2-rc.5 gives the Session controller an effect per Agent that owns
  // the real teardown. Disposing an Agent's registration scope alone would
  // leave its writer and registry entries open. Require the exact owner and
  // one exact effect, so an unfamiliar lifecycle is left alone.
  const owner = ctx.fiber.committed?.sessionController?.ctx.fiber
  const effects = owner?._disposables
  const label = `agentLoop.lifecycle(${sessionId})`
  const matches = effects?.[Symbol.iterator] && [...effects].filter(effect => effect[EFFECT]?.label === label)
  if (matches?.length !== 1) return { reason: 'session-live' }
  return { close: matches[0] }
}

async function artifactDirectory(persistence, snapshot, sessionId) {
  const { location, header } = snapshot
  if (persistence.name !== 'session-persistence-jsonl' || location?.kind !== 'jsonl') {
    throw new Error('unsupported-backend')
  }
  const root = persistence.root
  const directory = dirname(resolve(location.path))
  const project = dirname(directory)
  const storedId = basename(directory).replace(/~([\dA-F]{4})/g, (_, escape) => String.fromCharCode(parseInt(escape, 16)))
  if (!isAbsolute(location.path) || typeof root !== 'string' || dirname(project) !== resolve(root)
    || header.id !== sessionId || storedId !== sessionId
    || !/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(basename(location.path))) {
    throw new Error('unsafe-path')
  }
  const [projectInfo, directoryInfo, logInfo] = await Promise.all([lstat(project), lstat(directory), lstat(location.path)])
  if (!projectInfo.isDirectory() || !directoryInfo.isDirectory() || !logInfo.isFile()) {
    throw new Error('unsafe-path')
  }
  return directory
}

async function inspect(ctx, sessionId, signal) {
  const live = liveSession(ctx, sessionId)
  if (live.reason) return { deletable: false, reason: live.reason }
  if (live.close) return { deletable: true }
  const snapshot = await ctx.sessionPersistence.stat(sessionId, { signal })
  if (snapshot === undefined) return { deletable: false, reason: 'session-not-found' }
  if (snapshot.location?.kind !== 'jsonl') return { deletable: false, reason: 'unsupported-backend' }
  return { deletable: true }
}

async function removeArtifacts(directory) {
  if (process.platform === 'win32') {
    // Windows uses a named semaphore, so this atomic rename keeps the active
    // lease valid. Staged logs sit one level deeper than the catalog scans.
    const staging = await mkdtemp(join(dirname(directory), '.session-delete-'))
    try {
      await rename(directory, join(staging, 'artifacts'))
    } finally {
      await rm(staging, { recursive: true, force: true, maxRetries: 2 })
    }
    return
  }

  // POSIX locks the inode of session.lock. Preserve that inode so other
  // writers cannot acquire a replacement lock while this one is held.
  const entries = await readdir(directory)
  for (const entry of entries) {
    if (entry !== 'session.lock') await rm(join(directory, entry), { recursive: true, force: true })
  }
}

async function deleteSession(ctx, sessionId, signal) {
  const persistence = ctx.sessionPersistence
  if (persistence.name !== 'session-persistence-jsonl') return failure('unsupported-backend')

  const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, async () => [])
  if (activity.length > 0) return failure('session-running')

  const before = await persistence.stat(sessionId, { signal })
  const directory = before?.location ? await artifactDirectory(persistence, before, sessionId) : undefined
  signal.throwIfAborted()
  const live = liveSession(ctx, sessionId)
  if (live.reason) return failure(live.reason)
  if (live.close) {
    try {
      await live.close()
    } catch {
      return failure('session-close-failed')
    }
    if (ctx.sessions.get(sessionId) !== undefined || ctx.agents.get(sessionId) !== undefined) {
      return failure('session-live')
    }
  }

  const snapshot = await persistence.stat(sessionId, { signal })
  if (snapshot === undefined) {
    return live.close && directory === undefined ? deleted(ctx, sessionId) : failure('session-not-found')
  }
  const target = await artifactDirectory(persistence, snapshot, sessionId)
  if (directory !== undefined && target !== directory) return failure('unsafe-path')

  let handle
  try {
    handle = await persistence.open(sessionId, 'write', { signal })
  } catch (error) {
    if (error?.name === 'SessionAlreadyOwnedError') return failure('session-locked')
    if (error?.name === 'SessionPersistenceNotFoundError') return failure('session-not-found')
    throw error
  }
  try {
    const locked = await persistence.stat(sessionId, { signal })
    if (!locked || await artifactDirectory(persistence, locked, sessionId) !== target) return failure('unsafe-path')
    if (ctx.sessions.get(sessionId) !== undefined) return failure('session-live')
    signal.throwIfAborted()
    await removeArtifacts(target)
  } finally {
    await handle.close()
  }
  return deleted(ctx, sessionId)
}

function deleted(ctx, sessionId) {
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    // List refresh is still available after deletion.
  }
  return { ok: true, value: { sessionId, deleted: true } }
}

export function apply(ctx) {
  const deleting = new Set()
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (mediaType !== 'application/json') return Response.json(failure('bad-request'), { status: 415 })
      const payload = await request.json().catch(() => null)
      const { sessionId, action } = payload ?? {}
      if (typeof sessionId !== 'string' || sessionId.length === 0 || (action !== 'inspect' && action !== 'delete')) {
        return Response.json(failure('bad-request'), { status: 400 })
      }
      if (deleting.has(sessionId)) return Response.json(failure('delete-in-progress'))
      if (action === 'delete') deleting.add(sessionId)
      try {
        const result = action === 'inspect'
          ? { ok: true, value: await inspect(ctx, sessionId, request.signal) }
          : await deleteSession(ctx, sessionId, request.signal)
        return Response.json(result)
      } catch (error) {
        const code = ['unsafe-path', 'unsupported-backend'].includes(error?.message) ? error.message : 'delete-failed'
        return Response.json(failure(code))
      } finally {
        if (action === 'delete') deleting.delete(sessionId)
      }
    },
  }), 'session-delete: exact API route')
}
