# Session delete

Adds a **Delete session** action to the DSH session context menu.

## Install

Tested against DSH `0.2.2-rc.5`.

1. Open the DSH **Plugins** page.
2. Choose **Add plugin** → **Install a third-party plugin**.
3. In **Package name or address**, enter the absolute path of this directory (or of a packed `.tgz`).
4. Choose **Install** and confirm that **Session delete** is enabled.

The installed bundle is `@local/dsh-session-delete`. Keep the source directory in place: local directory installs are linked, so moving or deleting the directory breaks the installed plugin.

## Usage

1. Open the sidebar and right-click a session, or use its `...` button.
2. Choose **Delete session**.
3. Review the confirmation dialog and choose **Delete**.

The action permanently removes the per-session JSONL log directory from the configured session-persistence root. It cannot be undone.

## Limitation

Only sessions that are not open in the running DSH process can be deleted. Archive a running session first, restart DSH so its session is no longer live, then delete it. The Host refuses live sessions instead of deleting an open append handle. A session that is open in a view must be closed or left before it can be deleted. Subagent child logs and externally stored attachments are separate artifacts and are not removed by this action.

## Scope

The plugin adds one authenticated exact route (`/api/session-delete`) on DSH's shared Connection API channel, a Client context-menu contribution, and a confirmation dialog. It does not add model tools, prompts, or session events.
