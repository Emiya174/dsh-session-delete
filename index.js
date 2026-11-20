/**
 * Host half of the Session delete bundle.
 *
 * The browser posts to a small authenticated exact route on Connection's
 * shared API channel. This half only deletes a stored session that is not live
 * in the current process, and only when the persistence backend reports a
 * per-session JSONL artifact whose own directory name is exactly the session
 * id. Running sessions are refused so an open append handle can never be
 * pulled out from under the Session store.
 */

import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Plugin identity used by the loader row. */
export const name = 'dsh-session-delete'

/** Host services needed by the route. */
export const inject = ['connection', 'sessions', 'sessionPersistence']

/** Exact route owned on the shared API channel. */
const ROUTE = '/api/session-delete'

/**
 * Build one wire failure.
 * @param code - stable machine-readable failure code.
 * @param message - user-facing recovery text.
 * @returns an RPC-shaped failure result.
 */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Serialize one result as a JSON response.
 * @param result - endpoint result.
 * @param status - HTTP status.
 * @returns JSON response.
 */
function respond(result, status = 200) {
  return new Response(JSON.stringify(result), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Report whether one session can be deleted without touching a live Agent.
 * @param ctx - host plugin context.
 * @param sessionId - requested Session identity.
 * @param signal - caller cancellation.
 * @returns inspect result consumed by the context menu.
 */
async function inspectSession(ctx, sessionId, signal) {
  const live = ctx.sessions.get(sessionId) !== undefined
  if (live) {
    return { deletable: false, live: true, exists: true, reason: 'session-live' }
  }
  let snapshot
  try {
    snapshot = await ctx.sessionPersistence.stat(sessionId, { signal })
  } catch (error) {
    return {
      deletable: false,
      live,
      exists: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
  if (snapshot === undefined) {
    return { deletable: false, live, exists: false, reason: 'session-not-found' }
  }
  const location = snapshot.location
  const hasArtifact = location !== undefined && location.kind === 'jsonl'
  return {
    deletable: !live && hasArtifact,
    live,
    exists: true,
    reason: live ? 'session-live' : hasArtifact ? undefined : 'unsupported-location',
  }
}

/**
 * Delete one stored session artifact directory.
 * @param ctx - host plugin context.
 * @param sessionId - requested Session identity.
 * @param signal - caller cancellation.
 * @returns an RPC-shaped success or failure result.
 */
async function deleteSession(ctx, sessionId, signal) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return failure('bad-request', 'A non-empty sessionId is required.')
  }
  if (ctx.sessions.get(sessionId) !== undefined) {
    return failure(
      'session-live',
      'This session is open in the running DSH process. Archive it and restart DSH before deleting it.',
    )
  }
  let snapshot
  try {
    snapshot = await ctx.sessionPersistence.stat(sessionId, { signal })
  } catch {
    return failure('session-not-found', 'The stored session log was not found.')
  }
  if (snapshot === undefined) {
    return failure('session-not-found', 'The stored session log was not found.')
  }
  const location = snapshot.location
  if (location === undefined || location.kind !== 'jsonl') {
    return failure('unsupported-backend', 'This storage backend does not expose a deletable session artifact.')
  }
  const sessionDirectory = dirname(resolve(location.path))
  if (sessionDirectory === dirname(sessionDirectory)) {
    return failure('unsafe-path', 'The stored session location is not a per-session directory.')
  }
  // Claim the persistence write lease before removing anything. This makes a
  // second DSH process (or any other writer) fail the operation instead of
  // silently losing its log. The handle is closed before the directory is
  // removed because Windows may keep an open JSONL handle from being deleted.
  let handle
  try {
    handle = await ctx.sessionPersistence.open(sessionId, 'write', { signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
      return failure('session-locked', 'Another DSH process is writing this session.')
    }
    return failure('delete-failed', 'The stored session could not be locked for deletion.')
  }
  try {
    await handle.close()
  } catch {
    return failure('delete-failed', 'The stored session lock could not be released.')
  }
  try {
    await rm(sessionDirectory, { recursive: true, force: true })
  } catch {
    return failure('delete-failed', 'The stored session files could not be removed.')
  }
  // Tell every connected Client that the Session is gone; the Session
  // controller normally emits this on disposal, which a cold delete never
  // reaches.
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch {
    // The file removal is already durable; a missing event listener must not
    // turn it into a failure.
  }
  return { ok: true, value: { sessionId, deleted: true } }
}

/**
 * Register the exact Session delete route.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let payload
        try {
          payload = await request.json()
        } catch {
          return respond(failure('bad-request', 'The request body must be JSON.'), 400)
        }
        if (payload === null || typeof payload !== 'object') {
          return respond(failure('bad-request', 'The request body must be a JSON object.'), 400)
        }
        const sessionId = payload.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return respond(failure('bad-request', 'A non-empty sessionId is required.'), 400)
        }
        if (payload.action === 'inspect') {
          try {
            return respond({ ok: true, value: await inspectSession(ctx, sessionId, request.signal) })
          } catch (error) {
            return respond(failure('inspect-failed', error instanceof Error ? error.message : String(error)))
          }
        }
        if (payload.action === 'delete') {
          return respond(await deleteSession(ctx, sessionId, request.signal))
        }
        return respond(failure('not-found', `Unknown Session delete action "${String(payload.action)}".`), 404)
      },
    }),
    'session-delete: exact API route',
  )
}
