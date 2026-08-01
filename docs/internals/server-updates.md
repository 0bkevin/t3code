# Server Update Architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

T3 Code can update a connected server to the exact version of the client that detected version
drift. This path exists primarily for remote environments, where the user may not have a terminal
open on the server machine.

The feature has three boundaries:

- the server advertises whether and how it can be replaced;
- the client chooses the matching user action;
- the server installs and verifies the replacement before handing off the process.

## Detection and Presentation

`ExecutionEnvironmentDescriptor` includes the server version and an optional
`capabilities.serverSelfUpdate` value. Progress-capable servers also advertise
`capabilities.serverSelfUpdateProgress`. The client compares the server version with `APP_VERSION`
after loading server config.

The optional capability is intentionally backward compatible. An older server does not know about
the field, so a missing value means the client must offer a manual relaunch instead of sending an
unknown RPC.

The shared `ServerUpdateAction` is rendered in both user-facing version-drift surfaces:

- the conversation banner in `ChatView`;
- primary and saved environment rows in **Settings** → **Connections**.

Both surfaces target the client's exact version. When the reconnected server reports that version,
the mismatch and action disappear.

The operation state lives in `packages/client-runtime`, keyed by environment. Both web surfaces read
the same `downloading`, `installing`, or `resuming` state, so route changes do not own or cancel the
operation.

## Capability Selection

The server resolves its capability once at startup and publishes it in the environment descriptor.

| Advertised value  | Process shape                                                                                 | Client behavior                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `boot-service`    | Linux server running under the T3-managed systemd user service                                | Call the update RPC; the service unit is replaced and restarted.      |
| `respawn`         | Published npm CLI running in the foreground on macOS or Linux                                 | Call the update RPC; the process hands off to a detached replacement. |
| `desktop-managed` | Backend supervised by the desktop app                                                         | Tell the user to update the desktop app on the server machine.        |
| absent            | Older server, development checkout, Windows foreground process, or an unrecognized supervisor | Offer the exact manual relaunch command.                              |

Desktop ownership takes precedence over process-shape detection. A desktop-managed backend must
never spawn a second CLI server beside the app-owned process. Likewise, a process launched by an
unrecognized systemd unit does not claim the foreground respawn path because its supervisor could
bring the old version back.

## Update Flow

```mermaid
flowchart TD
    A[Client detects different versions] --> B{Advertised update path}
    B -->|desktop-managed| C[Update desktop app on server machine]
    B -->|missing| D[Copy exact manual relaunch command]
    B -->|boot-service or respawn| E{Progress capability}
    E -->|present| F[server.updateServerWithProgress]
    E -->|missing| G[server.updateServer fallback]
    F --> H[Install exact t3 version in pinned runtime]
    G --> H
    H --> I[Run version preflight]
    I -->|bad code or version| J[Remove candidate runtime and keep current server]
    I -->|cannot run preflight| J2[Keep candidate and current server]
    I -->|passes| I2[Run target database compatibility check]
    I2 -->|fails| J2
    I2 -->|passes| K{Handoff method}
    K -->|boot-service| L[Stage plan and start transient systemd helper]
    K -->|respawn| M[Start delayed replacement and exit current process]
    L --> L2[Helper activates unit and verifies target]
    L2 -->|target fails| L3[Restore and verify previous unit]
    L2 -->|target ready| N[Reconnect with fresh backoff]
    L3 --> N
    M --> N
    N --> O[Replacement publishes ready at target version]
```

Both update RPCs require the environment's `orchestration:operate` authorization scope. Their
payload accepts only an exact npm version, including an exact prerelease version; dist-tags such as
`latest` and `nightly` are rejected. The unary `server.updateServer` method remains available so a
new client can still repair skew with an older server.

The update service permits one update at a time. It installs `t3@<version>` under
`<baseDir>/runtime/versions/<version>` and writes an install-complete sentinel only after npm exits
successfully. Boot-service setup and self-update share the same process-wide installation lock, so
they cannot mutate a pinned runtime concurrently.

Before any restart, the current Node executable runs the replacement with `--version`, then asks
the target artifact to validate its migration identities against the live database in read-only
mode. A failed install, version preflight, or compatibility check leaves the current server running.
Targets old enough to lack the compatibility command are not eligible for remote activation.

Candidate cleanup is narrower than "any failed preflight". The candidate runtime is removed only when
the preflight process actually completes and reports a bad exit code or the wrong version: that is
the case where a completed npm install produced an unusable tree, so retrying the same version must
perform a clean install rather than reuse it. If the preflight cannot run at all, for example a spawn
error or the `PREFLIGHT_TIMEOUT` elapsing, the update fails before reaching cleanup and the candidate
directory is left in place.

## Host Service Lifecycle

The systemd user service is a host lifecycle concern, not a T3 Connect resource. The standalone
`t3 service install`, `uninstall`, `update`, and `status` commands own it. Install and update both
reconcile the unit through `BootService`; running `npx t3@latest service update` therefore pins and
activates the latest CLI release without requiring a connected client.

The `t3 connect` onboarding flow may offer service installation, but it calls the same reconciliation
operation as `t3 service install`. Connect logout only disables cloud access and clears its
authorization; it does not uninstall the host service.

## Process Handoff

For `boot-service`, the request process writes a typed plan but leaves its live unit untouched. It
starts a fixed-name `t3code-self-update.service` transient unit with `systemd-run --user`; the
transient unit has a separate cgroup and acts as the cross-process update lock. After a short grace
period it atomically installs the candidate unit, reloads systemd, performs a blocking restart, and
probes the public environment descriptor for the exact target version. If activation or readiness
fails, the helper restores the previous unit, clears systemd's failed state, restarts it, and proves
the previous version is ready. The plan and latest receipt live under the environment state
directory's `self-update` folder for diagnosis.

For `respawn`, the server starts a detached, delayed replacement that replays the original CLI
arguments. It then acknowledges the request and schedules the current process to exit. The delays
give the acknowledgement time to cross direct or relayed connections before the socket closes.

Progress-capable servers emit `downloading` before installing the pinned runtime and `installing`
before preflight and handoff. A terminal stream event acknowledges that restart is scheduled. The
client then enters `resuming`, waits for the intentional disconnect before accepting a new lifecycle
event, and requests one fresh retry to clear historical backoff debt. The first new `ready` event
must report the target version. A verified rollback therefore becomes an immediate wrong-version
error instead of looking like a two-minute timeout.

## Release Invariant

The exact client version must exist as the `t3` npm package before a client carrying that version is
published. The release workflow therefore makes the GitHub release depend on CLI publication, and
the hosted web deployment depends on that release. See [Release Checklist](../operations/release.md#server-self-update-release-invariant).

## Source Map

- Capability contract: `packages/contracts/src/environment.ts`
- Update RPC contract: `packages/contracts/src/server.ts` and `packages/contracts/src/rpc.ts`
- Capability detection and handoff: `apps/server/src/cloud/selfUpdate.ts`
- Systemd activation, health check, and rollback: `apps/server/src/cloud/systemdSelfUpdate.ts`
- Host service commands: `apps/server/src/cli/service.ts`
- Pinned runtime installation: `apps/server/src/cloud/pinnedRuntime.ts`
- Migration identity validation: `apps/server/src/persistence/Migrations.ts`
- Client version comparison: `apps/web/src/versionSkew.ts`
- Shared update action: `apps/web/src/components/ServerUpdateAction.tsx`
