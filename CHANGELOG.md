<!-- markdownlint-disable MD024 -->

# Release notes

## Unreleased

Absorbs the rtk command rewriting (previously a separate user extension) into the permission gate, applied **after** the approver's verdict instead of before evaluation.

### Added

- The gate now evaluates and prompts on the **original** bash command; the `rtk` rewrite is applied to the command that runs only after allow / edit / don't-ask-again (and on ungated calls). Rejected or blocked calls are never rewritten. This restores gating for commands that rtk would previously have wrapped into `rtk <command>` (which matched no hook and bypassed every guard).
- `permissions.rtk` settings (`enabled`, `timeoutMs`) in `~/.pi/agent/settings.json`, plus the existing `RTK_DISABLED=1` env override. rtk is required to be `>= 0.23.0`; when missing or too old, rewriting disables with a one-time warning and the gates are unaffected.
- Rewrites are fail-open and cached: a bounded 500-entry FIFO memo plus in-flight dedupe for parallel identical commands; timeout/kill/error leaves the original command unchanged.

### Changed

- Package renamed to `@rianico/pi-permission-lsz` (self-maintained fork of `@thurstonsand/pi-permissions`); permission modules now import `@rianico/pi-permission-lsz`.

## 0.10.0

Adds a don't-ask-again prompt outcome.

### Added

- Added a "Don't ask again" outcome to permission prompts: `ctrl+s` approves the tool call and disables the deciding permission check for the rest of the session branch, exactly as if you had approved and then run `/permissions disable <name>`. Any note drafted on the approve choice travels with the approval.

### Changed

- Mirror-environment dependency pins now live only on the `downgrade` branch; the published package no longer carries `overrides`.

## 0.9.0

Adds guided permission authoring.

### Added

- Added the user-invoked `/skill:create-permission` skill for turning plain-language tool-call policies into user-, project-, or package-level permission modules and testing them through Pi.

## 0.8.0

Adds editable bash approval prompts.

### Breaking

- Permission enablement now uses a strict hook-snapshot session format. Existing branch-local permission state entries are ignored, so affected hooks return to enabled by default until changed again.

### Added

- Added an Edit outcome for bash permission prompts, including multiline command editing, optional notes, `$EDITOR` support, and agent-facing context showing the command that actually ran.
- Added durable, branch-local transcript cards for permission enablement transitions, with compact summaries and expanded per-hook state.
- Added `editLabel` to permission request prompt customization.
- Added runnable example permission modules for common git, removal, environment-file, and GitHub release workflows.

### Changed

- Raised the minimum supported `@earendil-works/pi-*` versions to `0.80.4`.

## 0.7.3

### Fixed

- Multi-line highlight spans now keep their emphasis color on every wrapped line instead of only the first.

## 0.7.2

### Changed

- Pinned `node-addon-api` to `8.8.0`.

## 0.7.1

### Changed

- Pinned `web-tree-sitter` to `0.26.8`.

## 0.7.0

Adds predicate-based command matching for bash permission rules.

### Added

- Added `where` to `matchCommand()`'s `CommandSpec` — an arbitrary `(command) => boolean` predicate that narrows matches alongside `subcommands`.

## 0.6.0

Adds structural shell command parsing for bash permission rules.

### Added

- Added `parseShellCommand()`, `matchCommand()`, and `gitValueFlags` for bash command parsing and program/subcommand matching.
- Added precomputed highlight span arrays as a `request({ highlight })` option.

### Changed

- Permission hook evaluation now skips a throwing hook, continues evaluating later hooks, and reports the failure as a warning notification.
- Added `tree-sitter-bash` and `web-tree-sitter` as dependencies for shell command parsing.

## 0.5.0

Simplifies permission hook authoring and adds request prompt highlights.

### Breaking

- Removed the `matcher` field from permission hooks. Handlers should return `undefined` when a tool call is not relevant.

### Added

- Added request prompt highlights through `highlight` on `request()` prompts.
- Added `highlightSpans()` for resolving literal, RegExp, and callback-based highlight spans.

### Changed

- Updated README examples to use handler-based filtering and highlight offending command fragments.

## 0.4.0

Tracks permission enablement per hook instead of a single global switch.

### Added

- Added per-hook enablement: enable or disable individual permission hooks for the current session branch.
- Added an interactive `/permissions` modal with keyboard navigation, scrolling, draft edits, and save/cancel.
- Added targeted `/permissions enable <name>` and `/permissions disable <name>` for a single hook by exact, case-insensitive name.

### Changed

- `/permissions enable`, `/permissions disable`, and the `Alt+P` shortcut now apply to all currently loaded hooks, and the footer shows the active/loaded count (for example `permissions:3/5`).
- Agent-facing approval, block, and rejection messages now name the permission hook consistently.

## 0.3.0

Adds package-level permission hooks.

### Added

- Added package-bundled permissions through Pi package `pi.permissions` metadata and top-level `permissions/` convention directories.
- Added package permission filtering with Pi-style include, exclude, force-include, force-exclude, and empty-array disable semantics.
- Added `PermissionSource` metadata on registered hooks and load errors.

### Changed

- Added `minimatch` as a runtime dependency for package permission filter matching.

## 0.2.0

Simplifies the permission decision model and adds small authoring helpers.

### Breaking

- Authors returning `{ decision: "pass" }` should return `undefined` instead.

### Added

- Added `request()` and `block()` helpers for terminal permission decisions.
- Added `isCustomToolInput()` for narrowing custom tools by name.

### Changed

- Removed the explicit `pass` decision. Permission hooks now return `undefined` when they do not make a terminal decision.
- Custom tool inputs now expose record-shaped input data.

## 0.1.4

Initial release of `@thurstonsand/pi-permissions`.

### Added

- Added permission hook loading for user-level modules and trusted project-level modules.
- Added the public permission hook API, matcher helpers, and typed tool input helpers.
- Added interactive request prompts, pending approval state, and a permissions summary UI.
- Added `/permissions` for viewing loaded hooks and toggling checks per session branch.
- Added configurable toggle shortcut support via `permissions.toggleShortcut` (`alt+p` by default).
