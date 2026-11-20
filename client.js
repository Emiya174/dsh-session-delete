/**
 * Browser half of the Session delete bundle.
 *
 * Adds one structured action to the shared Session context menu and one
 * `shell.overlay` confirmation dialog. The dialog owns the destructive step:
 * it shows a pending state while the Host closes an idle session and removes
 * its stored artifacts. The dialog keeps any failure visible for retry.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete-live',
  factory(require) {
    const React = require('react')
    const NS = 'sessionDelete'
    const dictionaries = {
      en: {
        'menu.delete': 'Delete session',
        'dialog.title': 'Delete session?',
        'dialog.message': 'Delete "{title}"? The local session log will be permanently removed and cannot be restored.',
        'dialog.delete': 'Delete',
        'dialog.deleting': 'Deleting…',
        'dialog.cancel': 'Cancel',
        'session.untitled': 'Untitled',
        'toast.deleted': 'Session deleted.',
        'toast.deletedPending': 'Session deleted. Refresh this page to update the list.',
        'toast.failed': 'Could not delete the session.',
        'toast.live': 'DSH could not close this session here. Close the client or feature that owns it, then try again.',
        'toast.running': 'This session has active work. Stop it or wait for it to finish before deleting.',
        'toast.closingFailed': 'The session did not close cleanly. Try again after it has closed.',
        'toast.deleteInProgress': 'Deletion is already in progress for this session.',
        'toast.retained': 'This session is open in a view. Switch to another session before deleting it.',
        'toast.locked': 'Another DSH process is writing this session. Close it before deleting this session.',
        'toast.notFound': 'The session log was not found.',
        'toast.unsupported': 'This storage backend does not support deleting sessions.',
      },
      zh: {
        'menu.delete': '删除会话',
        'dialog.title': '删除会话？',
        'dialog.message': '删除「{title}」？将永久删除本地会话日志，且无法恢复。',
        'dialog.delete': '删除',
        'dialog.deleting': '正在删除…',
        'dialog.cancel': '取消',
        'session.untitled': '未命名',
        'toast.deleted': '会话已删除。',
        'toast.deletedPending': '会话已删除，请刷新当前页面以更新列表。',
        'toast.failed': '删除会话失败。',
        'toast.live': '此处无法关闭这条会话。请关闭管理它的客户端或功能，再试一次。',
        'toast.running': '这条会话还有任务在运行。请先停止任务，或等它结束后再删除。',
        'toast.closingFailed': '会话关闭时出错。请在会话关闭后重试。',
        'toast.deleteInProgress': '正在删除这条会话。',
        'toast.retained': '该会话正在界面中打开，请先切换到其他会话后再删除。',
        'toast.locked': '另一个 DSH 进程正在写入该会话，请先关闭它后再删除。',
        'toast.notFound': '未找到该会话日志。',
        'toast.unsupported': '当前存储后端不支持删除会话。',
      },
    }

    /** Small store for the one open confirmation request. */
    function createRequestStore() {
      let value = null
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** Trash glyph used by the context menu contributor. */
    function TrashIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: 14,
        height: 14,
        'aria-hidden': true,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
      React.createElement('path', { d: 'M4 7h16' }),
      React.createElement('path', { d: 'M9 7V4.5h6V7' }),
      React.createElement('path', { d: 'M6.5 7l.9 13h9.2l.9-13' }),
      React.createElement('path', { d: 'M10 11v6M14 11v6' }))
    }

    return {
      inject: ['contextMenus', 'sessions', 'locale', 'slots', 'remoteAccess'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'session-delete: dictionaries')
        const t = ctx.locale.bind(NS)
        const requestStore = createRequestStore()

        const styles = {
          backdrop: {
            position: 'fixed', inset: 0, zIndex: 10000, display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: '24px',
            background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.32))',
          },
          card: {
            width: 'min(420px, 100%)', boxSizing: 'border-box', padding: '20px 22px 18px',
            borderRadius: '12px', border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
            background: 'var(--dsw-alias-bg-overlay, #fff)', color: 'var(--dsw-alias-label-primary, #111)',
            boxShadow: '0 16px 48px var(--dsw-alias-bg-mask-2, rgba(0, 0, 0, 0.2))',
            fontFamily: 'inherit',
          },
          title: { margin: '0 0 10px', fontSize: '16px', fontWeight: 600, lineHeight: 1.4 },
          message: { margin: '0 0 20px', fontSize: '14px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #555)' },
          footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px' },
          secondary: {
            padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
            background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer',
          },
          danger: {
            padding: '7px 14px', borderRadius: '8px', border: '1px solid transparent',
            background: 'var(--dsw-alias-state-error-primary, #c0392b)', color: '#fff',
            font: 'inherit', cursor: 'pointer',
          },
        }

        /** Confirmation dialog rendered through the frame overlay slot. */
        function ConfirmDialog() {
          const request = React.useSyncExternalStore(
            requestStore.subscribe, requestStore.get, requestStore.get,
          )
          const [busy, setBusy] = React.useState(false)
          const [failure, setFailure] = React.useState(null)
          const cancelRef = React.useRef(null)
          React.useEffect(() => {
            setFailure(null)
            if (request !== null) cancelRef.current?.focus()
          }, [request])
          React.useEffect(() => {
            if (request === null) return undefined
            const onKeyDown = (event) => {
              if (event.key === 'Escape' && !busy) {
                event.preventDefault()
                requestStore.set(null)
              }
            }
            document.addEventListener('keydown', onKeyDown)
            return () => document.removeEventListener('keydown', onKeyDown)
          }, [request, busy])
          if (request === null) return null
          const close = () => { if (!busy) requestStore.set(null) }
          const confirm = async () => {
            if (busy) return
            setBusy(true)
            setFailure(null)
            try {
              const message = await request.onConfirm()
              if (message) setFailure(message)
              else requestStore.set(null)
            } catch {
              setFailure(t('toast.failed'))
            } finally {
              setBusy(false)
            }
          }
          return React.createElement('div', {
            style: styles.backdrop,
            onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
          }, React.createElement('div', {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'session-delete-title',
            style: styles.card,
            onMouseDown: (event) => { event.stopPropagation() },
          },
          React.createElement('h2', { id: 'session-delete-title', style: styles.title }, t('dialog.title')),
          React.createElement('p', { style: styles.message }, t('dialog.message', { title: request.title })),
          failure && React.createElement('p', { role: 'alert', style: styles.message }, failure),
          React.createElement('div', { style: styles.footer },
            React.createElement('button', {
              ref: cancelRef, type: 'button', style: styles.secondary, disabled: busy, onClick: close,
            }, t('dialog.cancel')),
            React.createElement('button', {
              type: 'button', style: styles.danger, disabled: busy, onClick: () => { void confirm() },
            }, busy ? t('dialog.deleting') : t('dialog.delete')))))
        }

        const failureKey = (reason) => {
          if (reason === 'session-live') return 'toast.live'
          if (reason === 'session-running') return 'toast.running'
          if (reason === 'session-close-failed') return 'toast.closingFailed'
          if (reason === 'delete-in-progress') return 'toast.deleteInProgress'
          if (reason === 'session-locked') return 'toast.locked'
          if (reason === 'session-not-found') return 'toast.notFound'
          if (reason === 'unsupported-location' || reason === 'unsupported-backend') return 'toast.unsupported'
          return 'toast.failed'
        }

        /**
         * Call the plugin's exact Host route.
         * @param action - inspect or delete.
         * @param sessionId - captured Session identity.
         * @returns endpoint value.
         */
        const call = async (action, sessionId) => {
          const response = await fetch('api/session-delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, sessionId }),
          })
          let result
          try {
            result = await response.json()
          } catch {
            const error = new Error('session-delete transport failure')
            error.code = 'transport'
            throw error
          }
          if (result.ok !== true) {
            const error = new Error(result.error?.message || 'session-delete failure')
            error.code = result.error?.code
            throw error
          }
          return result.value
        }

        const messageOf = (error) => {
          const key = failureKey(error?.code)
          return key === 'toast.failed' ? t('toast.failed') : t(key)
        }

        const isRetained = (sessionId) => ctx.sessions.retainInfo(sessionId).getSnapshot().referenceCount > 0

        /**
         * Open the confirmation dialog for one Session.
         * @param target - captured Session row identity and display title.
         */
        const requestDelete = async (target) => {
          if (isRetained(target.sessionId)) {
            ctx.contextMenus.notify(t('toast.retained'), false)
            return
          }
          try {
            const info = await call('inspect', target.sessionId)
            if (info.deletable !== true) {
              ctx.contextMenus.notify(t(failureKey(info.reason)), false)
              return
            }
          } catch (error) {
            ctx.contextMenus.notify(messageOf(error), false)
            return
          }
          requestStore.set({
            sessionId: target.sessionId,
            title: target.displayTitle || t('session.untitled'),
            onConfirm: async () => {
              if (isRetained(target.sessionId)) return t('toast.retained')
              try {
                await call('delete', target.sessionId)
              } catch (error) {
                return messageOf(error)
              }
              try {
                await ctx.sessions.refresh()
              } catch {
                // Deletion already completed. The user can refresh the page if needed.
              }
              const listed = ctx.sessions.list.getSnapshot().ids.includes(target.sessionId)
              ctx.contextMenus.notify(listed ? t('toast.deletedPending') : t('toast.deleted'), !listed)
            },
          })
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete.confirm',
        }, ConfirmDialog))
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: 'sessionDelete.trash',
        }, TrashIcon))
        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.delete',
          target: 'session',
          order: 700,
          resolve: (target) => {
            try {
              if (ctx.remoteAccess.source('session', target.sessionId, 'session-delete/delete').getSnapshot() !== true) {
                return []
              }
            } catch {
              return []
            }
            return [{
              id: 'delete',
              label: t('menu.delete'),
              icon: { key: 'sessionDelete.trash' },
              danger: true,
              separatorBefore: true,
              afterContent: true,
              run: () => { void requestDelete(target) },
            }]
          },
        }), 'session-delete: session context menu')
      },
    }
  },
})
