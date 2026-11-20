import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as DeleteSession from '../index.js'

// Run with DSH's Electron executable and ELECTRON_RUN_AS_NODE=1 on Desktop.
const packages = dirname(process.env.DSH_INSTALL_DIR)
const load = (pkg) => import(pathToFileURL(join(packages, pkg, 'lib', 'index.js')))
const [{ Context }, { default: Sessions }, { default: Agents }, { default: Projections },
  { default: SystemPrompt }, { default: AgentLoop }, Jsonl] = await Promise.all([
  load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-session-projection'),
  load('dsh-system-prompt'), load('dsh-agent-loop'), load('dsh-session-persistence-jsonl'),
])
const temp = await mkdtemp(fileURLToPath(new URL('./.session-delete-test-', import.meta.url)))
const ctx = new Context()
const install = async (plugin, config) => {
  const fiber = ctx.plugin(plugin, config)
  await fiber.await()
  return fiber
}
const dependencies = []
try {
  ctx.provide('llm', {})
  ctx.provide('tools', {})
  dependencies.push(await install(Sessions))
  dependencies.push(await install(Projections))
  dependencies.push(await install(Agents))
  dependencies.push(await install(SystemPrompt))
  dependencies.push(await install(Jsonl, { root: join(temp, 'sessions'), compression: 'none' }))
  dependencies.push(await install(AgentLoop))

  const owner = await install({
    name: 'test-session-controller',
    inject: ['agents'],
    apply(ownerCtx) { ownerCtx.provide('sessionController', { ctx: ownerCtx }) },
  })
  let route
  ctx.provide('connection', { fetch: { register: (value) => { route = value } } })
  const plugin = await install(DeleteSession)
  const id = `session-${randomUUID()}`
  const other = `session-${randomUUID()}`
  const blank = `session-${randomUUID()}`
  const foreign = `session-${randomUUID()}`
  const create = (sessionId) => owner.ctx.agents.create({ sessionId, meta: { cwd: temp } })
  const call = async (action, sessionId) => (await route.fetch(new Request(`http://dsh.internal${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, sessionId }),
  }))).json()
  const { dispose: disposeForeign } = await ctx.agents.create({ sessionId: foreign, meta: { cwd: temp } })
  try {
    const { agent } = await create(id)
    const { dispose: closeOther } = await create(other)
    await ctx.sessionPersistence.flush()
    const log = (await ctx.sessionPersistence.stat(id)).location.path
    await create(blank)

    assert.equal(ctx.sessions.get(id), agent.session)
    assert.deepEqual((await call('inspect', id)).value, { deletable: true })
    const stopReporting = ctx.on('workspace/session-activity', async ({ sessionId }, next) =>
      sessionId === id ? [{ kind: 'turn' }] : next())
    assert.equal((await call('delete', id)).error.code, 'session-running')
    stopReporting()
    assert.ok(ctx.sessions.get(id))
    assert.equal((await call('delete', foreign)).error.code, 'session-live')
    assert.ok(ctx.sessions.get(foreign))

    assert.equal((await call('delete', id)).ok, true)
    assert.equal(ctx.sessions.get(id), undefined)
    assert.equal(ctx.agents.get(id), undefined)
    assert.equal(await ctx.sessionPersistence.stat(id), undefined)
    const { access } = await import('node:fs/promises')
    await assert.rejects(access(log), { code: 'ENOENT' })
    assert.equal((await call('delete', id)).error.code, 'session-not-found')
    assert.ok(ctx.sessions.get(other))
    assert.ok(await ctx.sessionPersistence.stat(other))

    assert.equal((await call('delete', blank)).ok, true)
    assert.equal(ctx.sessions.get(blank), undefined)
    await closeOther()
    const writer = await ctx.sessionPersistence.open(other, 'write')
    try {
      assert.equal((await call('delete', other)).error.code, 'session-locked')
      assert.ok(await ctx.sessionPersistence.stat(other))
    } finally {
      await writer.close()
    }
    assert.equal((await call('delete', other)).ok, true)
    assert.equal(await ctx.sessionPersistence.stat(other), undefined)
    console.log('DSH JSONL integration passed: live, cold, blank, active, foreign owner, writer held, and repeated deletion')
  } finally {
    await disposeForeign()
    await plugin.dispose()
    await owner.dispose()
  }
} finally {
  for (const fiber of dependencies.reverse()) await fiber.dispose()
  await rm(temp, { recursive: true, force: true })
}
