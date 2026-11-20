# Session delete

Adds a **Delete session** action to the DSH session context menu.

## Install

Tested against DSH `0.2.2-rc.5`.

1. Open the DSH **Plugins** page.
2. Choose **Add plugin** → **Install a third-party plugin**.
3. In **Package name or address**, enter the absolute path of this directory (or of a packed `.tgz`).
4. Choose **Install** and confirm that **Session delete** is enabled.

When upgrading from `@local/dsh-session-delete`, uninstall that bundle first. The replacement is `@local/dsh-session-delete-live`. Keep the source directory in place when installing from a local directory because DSH links to it.

## Usage

1. Open the sidebar and right-click a session, or use its `...` button.
2. Choose **Delete session**.
3. Review the confirmation dialog and choose **Delete**.

An idle conversation can be deleted without restarting DSH. The host closes an idle agent through its existing lifecycle cleanup, takes the JSONL write lease, and permanently removes the session artifacts while holding the lease.

## Limitations

- Switch away from the target session and close any view displaying it before deleting.
- Wait for active work in the target session to finish or stop it first. Live sessions owned by other features and sessions locked by another process must be released by their owners.
- Subagent logs and externally stored attachments are separate artifacts.
- Live deletion uses the per-agent cleanup effect in DSH `0.2.2-rc.5`. This version of the plugin declares that exact DSH version for compatibility.

The host exposes an owner-only action on DSH's shared Connection API channel at `/api/session-delete`.
