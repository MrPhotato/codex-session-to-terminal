# Cloud Work development status

## Current scope: read-only terminal (2026-10-21)

The user changed the cloud product scope to observation only. The tray now has
an explicit cloud-session selector backed by the official Desktop list/read
tools. It selects native `codex` / `durable` identities directly. Native durable
links route directly through the same shortcut into the read-only launcher.
On a ChatGPT page that emits no native link, a bounded UI Automation title
observation can suggest one read-only candidate; otherwise the selector opens.
This is not a proven ChatGPT/native ID mapping. The list contains recent (up to 50 total) and
pinned conversations, and an existing cloud owner is still required.

The tray observes only the exact Ctrl+Alt+L chord with passive Windows keyboard
raw input while the verified Desktop process is foreground. It neither
registers the existing shortcut nor suppresses/injects keys. The original
copy-link action gets 900 ms to produce a supported local/durable link; a
matching clipboard action cancels selection, including a deduplicated action.
Otherwise a hidden title probe starts only while the same Desktop process generation
and source window remain foreground. Focus changes, stale requests and exit
cancel it. Repeated L-down events do not open repeated terminals. The listener
retains only modifier/L state, never arbitrary keys or text; the legacy
watcher's one-argument constructor leaves observation disabled. Registration
failure preserves local clipboard handling and reports the tray-menu alternative.
Parser, pure chord-state, exact durable-launch and fallback cancellation tests
passed, together with 20 related JavaScript lifecycle/launcher tests. A hidden
native lifecycle probe registered/released the observer twice without pumping
events, reading clipboard contents, sending input or changing foreground. The
official read tool also confirmed the dedicated test native thread remains
`codex` / `durable` and readable. These checks do not replace a physical-key
acceptance test. The installed tray must be exited/reopened once to load the
updated listener; ChatGPT does not need to restart.

### Current-page title matching

The title helper binds the shortcut's exact HWND/PID/process generation to the
official packaged executable, current user and Windows session. It reads only
the unique main Document's Name, URL and runtime ID, stopping at Document nodes
without traversing chat bodies. Its before/after observations and process
identity must agree. The tray polls this child without blocking its message
loop; missing helpers, unsupported UIA, or a 1500 ms timeout retain the picker.
A late native clipboard link, focus change, replacement shortcut, or exit
disposes only this owned child. No Desktop process or credentials are changed.

The observation is passed in memory as a short-lived context (maximum 30 s).
Matching uses raw full titles, requires exactly one frontend and one durable
entry with that title in the supplied catalog, and rejects other-host/local
collisions, conflicting duplicate records, generic names and control text.
The candidate is read back and its native identity/title checked; the source
Document is read again before accepting it. Failed checks use manual selection.
The normal tray-menu selector and exact native links do not read UIA.

Uniqueness is only within recent/pinned results, not account-wide. Names may
diverge between frontend and native execution; in that case manual selection
remains necessary. No frontend/native ID mapping is persisted, and title hints
never grant sending, steering, interruption, or navigation to a guessed ID.
The source helper has been read-tested against a live Desktop document; cloud
shortcut acceptance still requires the installed application to be exercised.

The original Windows CLI runs inside a dedicated ConPTY. A terminal emulator
renders only its visible cells, masks its four composer/footer rows and shows
the fixed text `Online Session Read Only for Terminal`. Only Page Up, Page
Down, Ctrl+Home, Ctrl+End and mouse-wheel paging reach the CLI. Ordinary text,
bracketed paste, Enter, Tab, Esc, Ctrl+C/D, settings and commands are ignored.
The explicitly requested Desktop-navigation button is the only additional
click action; it is separate from the cloud RPC connection and cannot send
conversation input. Terminal-generated device replies are kept separate from user input. Resizing
redraws in place; very small windows show the banner alone. Closing the window
or exiting the tray closes only the viewer and its own helpers.

`cloud-windows-attachment` and its proxy are strictly read-only. Removed
interrupt opt-ins and callbacks are rejected. Send, steer, queue, interruption,
approvals and configuration writes are denied even if keyboard filtering is
bypassed. The product does not load the historical interrupt controllers.
The CLI's adapter-scoped skills catalog is empty; it does not enumerate,
refresh or install real executor skills. Unsupported media/resources fail
explicitly. Cloud workspace strings are mapped to an unregistered Windows
display namespace; no local directory or mount is created for them.

The launcher creates a separate CLI home beneath its tray run directory. The
official read helper uses Desktop app-tools and may write its own logs/cache;
it is archived and closed on exit. Desktop installation, startup, credentials
and local-session controls are unchanged. The app-tools endpoint is verified
before the plugin's separate connection; this is not an atomic same-handle
identity guarantee for that plugin connection.

The sections below retain the earlier investigation and evidence. Historical
interrupt/send demonstrations are not capabilities of the current read-only
product. The earlier full-control release gates do not authorize cloud writes.

### Read-only acceptance

The product reader, selector catalog, follower attachment and original Windows
CLI were tested together against the dedicated cloud execution. The official
catalog listed 16 durable candidates and included the exact test identity.
The viewer displayed its existing history. Typed text, bracketed paste, Enter,
Tab, Esc, Ctrl+C/D and command text changed neither the screen nor the bridge
request counts. Page Up/Down and Ctrl+Home/End changed the displayed history.
The banner remained visible at 100x32 and 72x24; a 25x8 viewport showed the
wrapped banner. No composer or typed test marker leaked in 29 observed frames,
and no cloud write request occurred. Abort waited for viewer cleanup and raw
input mode was restored. This was a headless ConPTY integration check, not a
manual acceptance of the installed Windows Terminal window or tray menu.

The live test also covered the cloud executor's `externalSandbox` permission
metadata without changing it. Named permission profiles and filesystem-bearing
sandbox policies remain outside the Windows display projection. The original
full-control test markers remain historical data; no new cloud message was
sent during read-only acceptance. A second run after the resize-guard fix also
verified that history returns after restoring the normal viewport (27 frames,
no composer or input leaks, no writes). The final JavaScript suite passed
381/381, the PowerShell suite passed, installer staging tests passed, and the
source startup check reported `ready: true`. Checks were run sequentially
after the machine recovered from unrelated and test-process memory pressure.

### Fixed Desktop-navigation toolbar

Both local and cloud launchers now host the unchanged official Windows CLI
below a single fixed top row. Its right-aligned localized button binds to the
terminal's exact session ID. Local input and mouse coordinates are forwarded
to the CLI below that row; the cloud input restrictions remain in force.
The fullscreen and alternate-screen settings are process-only overrides.

A click uses the official `codex://threads/<native-UUID>?hostId=<local|durable>`
deep link. The installed AppX manifest registers this protocol with
`--single-argument`; current bootstrap and main handlers parse it, forward
second-instance arguments, and navigate the native thread route. The product
invokes only the already verified running Desktop executable with these two
literal arguments, bypassing the system's default protocol association. It
never searches conversation text for a target or uses the cloud control
connection. Durable targets open the cloud execution view, not an inferred
original Work conversation. A `dispatched` result is not a page-ready receipt.

One precompiled Windows helper captures the terminal and a unique official
Desktop window, then checks process/window identity, same user/session and
unchanged foreground before dispatch. Package full name, family and path are
queried through Windows APIs on the same process handle; the package family
and the exact package-root executable must match. No PowerShell, runtime
compilation, model executor or helper thread is required for an installed
button click. Source checkouts without a built helper retain the PowerShell
fallback; a failed/uncertain native dispatch is never retried through fallback.
Ambiguity or a missing/changed source/target prevents dispatch. No keys,
injection or always-on-top flags are used. The helper exits after each click.
The normal single-instance handoff is not an atomic PID-addressed API: if the
verified main instance exits precisely after the last check, its executable
may start an application instance. Environment overrides for test profiles,
build flavor, relaunch events and Node/Electron execution are removed.

The user's first installed toolbar test confirmed navigation but took over
ten seconds. A serial read-only timing probe measured 5.544 seconds for the
former cold helper plus identity read, 1.685 seconds for a warm read, and
1.812 seconds for one focus helper's startup/compilation/package discovery.
The new deep-link path removes the executor and both tool calls, and combines
window work in one process. These measurements explain the old delay; the
new actual page-switch latency still requires an installed-window check.
The optimized action, both launcher integrations and terminal toolbar passed
44 targeted JavaScript tests. The complete focus/dispatch fixture suite also
passed, including exact argv, environment isolation, one package lookup,
one dispatch and source/target changes. These checks did not dispatch a real
deep link or switch the user's current page.

The user subsequently confirmed the deep-link revision was noticeably faster.
The next revision replaces that single PowerShell process with the compiled
helper. Five serial inert `--check` launches took 119.9, 52.4, 52.7, 55.8 and
60.1 ms (median 55.8 ms). These timings exclude dispatch, foreground changes
and Desktop page loading. A separate read-only native enumeration found one
running official Desktop window, verified its package identity and took
27.2 ms; it did not dispatch or change foreground. The native revision passed
eight C# contract groups, 56 related JavaScript tests and installer staging
checks, all run serially. End-to-end click latency still needs the user's
installed-window check; startup timings alone do not establish it.

The user's first native-helper check failed to navigate. The Framework helper
wrapped the URI in quotes, unlike the working PS7 `ArgumentList` serializer.
Chromium's `--single-argument` consumes the raw command-line tail, including
those quotes, so ordinary argv equivalence was insufficient. The previous
fixture incorrectly accepted both forms. The regression now fails against
the old code and passes only the exact unquoted URI; a pure-object check also
compares native arguments with the actual PS7 `BuildArguments()` serializer
for local and durable targets. No Desktop launch is used by that check.
Reference: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/base/command_line.cc#788

The toolbar also swallowed official CLI title updates because repainting cells
does not reproduce OSC 0/2 metadata. The wrapper now forwards only the parsed,
bounded title through a reconstructed OSC 2 sequence, retaining Chinese and
emoji while filtering control characters. Cloud CLI launch enables its
`thread-name` title for this process; local CLI title preferences are preserved.
Cloud input remains read-only. The corrected revision passes 77 related
JavaScript tests and all eight native fixture groups plus PS7 serialization
parity. Installed click/focus and tab-title acceptance remain manual checks.

Two serial real-CLI ConPTY checks each observed 31 frames, fixed button clicks,
paging, resized hit targets, cancelled held clicks and restored history.
The strict cloud view ignored ordinary input and produced zero write requests.
The local presentation mode displayed Chinese draft input and bracketed paste;
the unsent draft was cleared. That presentation check used the dedicated cloud
test's read-only transport because the earlier local test owner was unavailable.
It does not establish a fresh end-to-end local Desktop attachment. Both checks
used a simulated navigation callback: no Desktop page or foreground was changed.
Actual installed-window click/focus acceptance remains a manual check.

The toolbar revision passed 419/419 JavaScript tests and the PowerShell suite,
run sequentially. This includes byte-preserving local input, rendered OSC8
links, cloud input filtering, click fragmentation/resize, navigation identity
checks and mocked foreground guards. Those tests do not substitute for manual
acceptance of the actual Desktop page and foreground behavior.

## Historical full-control investigation

**Full-control status: blocked, not complete (2026-10-21).** Three consecutive goal
turns encountered the same missing control contract. The final audit checked
the unchanged Desktop 26.1013.4894.0 / app-tools 0.1.6 installation and reread
both sides of the dedicated test. Native history still contains completed J
between interrupted K and I; the original frontend contains K, I and H instead.
No new message was sent during this audit.

Full bidirectional control needs an independently reachable sender that writes
the original ChatGPT graph, accepts or returns request-correlated message
identity, and preserves caller-selected start/steer/queue intent with a genuine
admission result. The inspected interfaces do not provide that combination.
The remaining selection, identity-mapping, cold-owner and Windows protocol
gates below also remain open. A concrete new interface or an explicit change
to the requested workflow is needed before resuming full-control development;
the tested observation/interrupt modules remain available for that work.

## Verified transport

A separate official Codex app-server can create its own real local helper
thread, then call the installed official `codex-app-tools` MCP plugin through
the public `mcpServer/tool/call` interface. The executor supplies the helper's
thread metadata; the plugin communicates with the running Desktop application.
Desktop retains responsibility for ChatGPT authentication.

The transport module retrieved a dedicated cloud Work conversation and its
known response in a live read-only test. Its first read took about 3.9 seconds;
a second read on the same connection took about 0.23 seconds and retained the
same message IDs. These are individual observations, not performance guarantees.
In particular, a fast repeated read may return cached history; it does not
establish fresh or streaming output.
No model turn was run in the local helper. The helper was archived and its
executor exited after the test.

The helper must be named before calling Desktop tools so that its metadata is
available to the renderer. The inspected executor also requires safe bare MCP
server names in command-line configuration overrides; quoting that key caused
startup failure. Both compatibility cases have regression coverage.

This route does not require copying account credentials, modifying ChatGPT,
changing its startup, injecting code into it, or impersonating an existing
agent. Plugin configuration overrides apply only to the helper process.
Production callers must resolve and validate the installed official executables,
plugin and current Desktop pipe endpoint.

## Limits of the app-tools summary route

- The ChatGPT page does not register the Codex `copy-deeplink` handler used by
  the current shortcut.
- For a ChatGPT conversation, `read_thread` returns a display summary. Its
  `turns` are message groups, with
  group IDs based on user messages and a fixed completed status. They are not
  authoritative execution turns. The separately returned thread status is
  an observed UI snapshot, not an atomic guarantee that the next send will
  start a new turn.
- `send_message_to_thread` returns the conversation ID after submission. It
  does not return a unique message receipt or native Codex turn ID.
- The inspected ChatGPT history query has a one-minute freshness window.
  Live tests observed changing active/idle status while the message list
  remained stale, then both new messages appeared roughly one minute after
  submission. Frequent polling alone does not bypass that cache. A separate
  targeted cache-invalidation experiment retrieved the new history sooner,
  as described below; it does not provide a live event stream.
- The send tool may internally steer an active cloud task. An earlier idle
  read does not prevent that race. The interface inspected so far provides
  neither a caller-selected send/steer operation nor an atomic idle-only send.
  It also does not expose generation interruption or a raw live event
  subscription. Cancelling a tool request is not equivalent to stopping
  cloud generation.
- Official CLI resume requires model, execution permissions, workspace and
  turn lifecycle fields that the cloud summary does not supply. The separate
  native follower route below now supplies these facts. Inventing
  these values, reporting a false writer conflict or copying the cloud history
  into a separate executing thread is not a supported attachment.

The dedicated cloud test also has an associated Codex execution on the
`durable` host. Reading that execution with the official app tool returned
real native turn IDs, status, timing and workspace. A later read verified that
Tests A, B and C all appeared in that same execution, with real native turn
and item identities. The independent `CloudAppToolsClient.readConversation`
path was then also verified against the associated execution ID: the official
tool resolved it to `hostId: durable`, returned Test C's real turn and response,
and retained item IDs on a repeat read. First/repeat reads took about 5.0/1.75
seconds in that single experiment; its helper was archived after cleanup.
The tool still omits model and permission settings. A subsequent direct native
write succeeded in this execution but did **not** appear in its paired ChatGPT
conversation, including after a targeted history refresh. The two identities
are not interchangeable send targets.

An ambiguous send must never be retried automatically. Matching message text
alone does not establish a unique delivery receipt.

## Native durable follower connection

The ordinary owner-discovery method in this packaged Desktop build only
discovers local renderer owners. That failure does not establish that a cloud
owner is absent. Normal follower-request discovery can find the actual durable
owner using `thread-follower-read-model-settings`, version 2, with top-level
`hostId: 'durable'` and the real native conversation ID. Its successful
`handledByClientId` identifies the owner through the existing router's owner
checks. The independent client then follows that owner through the normal
version-1 following broadcast. State snapshots and patches use version 11.

`DesktopIpcClient` now accepts an explicit `hostId: 'durable'`. The default
local path is unchanged. Durable frames validate the initialized client,
owner, target, host, conversation and revision. The client does not announce
ownership, resume an execution, modify Desktop, or borrow another identity.
Durable native writes are disabled by default. The broad experimental control
flag, the separate interrupt-only flag and the separate admission flag all
default to false. The low-level request gate also binds writes to the current
owner and conversation, regardless of the caller's write classification.
Only an isolated authorized experiment may opt in.

Opening the existing test execution through the normal native Desktop view
created a real owner. The user authorized a brief page switch and restoration;
both switches were restored. An independent follower subsequently obtained
the actual model, permissions, workspace, runtime status, canonical history
and turn/item identities in roughly two seconds. All earlier A/B/C markers
were present. Top-level `turns: []` was normal: history lived in canonical
`turnHistory`. The normal page-open did perform Desktop's own resume; it must
not be described as side-effect-free. An owner may be released after the
native view and followers are gone. Automatic activation and current cloud
page selection remain unresolved product work.

Two live paths were then distinguished:

- **D, native write:** one ordinary plaintext follower start returned a real
  native turn ID. The independent follower received 22 updates, five response
  deltas and completion; all projected events passed the official notification
  schema. An independent native read confirmed the exact answer. The original
  ChatGPT conversation still lacked D after refresh. This path must remain
  disabled for product cloud sends.
- **F, official frontend write plus native read:** one authorized official
  app-tool submission appeared in the original ChatGPT conversation while the
  native follower received 18 updates, four response deltas and completion.
  The native user item's `clientId` exactly matched the ChatGPT user message
  ID, establishing a cross-history identity link. The owner remained ready
  while the original page was restored. The tool call itself still returned
  no unique message receipt, so this does not close the submission-correlation
  gap or validate steer, queue and stop semantics. E also completed in both
  histories, but its observer exited prematurely on a temporary resync; it is
  not evidence of complete live observation.

Cloud native start can admit or steer according to the owner/runtime path;
generic steer does not accept a caller-bound expected turn. Frontend stop and
steer also maintain ChatGPT-specific stream and message state. Native control
must not be labeled equivalent to those frontend controls without validation.

`cloud-native-metadata.mjs` projects genuine native snapshot fields for CLI
resume. It preserves runtime settings and source, and explicitly reports
unknown creation-version/project display fields. It represents unknown CLI
version as an empty string and unexposed project membership as null; those
are not claims about backend membership. `ephemeral: false` requires an
explicit prior persisted-thread read. The live F baseline passed the official
`ThreadResumeResponse` schema with this projection and canonical history.
Schema validity alone does not establish successful official CLI startup.

`cloud-native-cli-bridge.mjs` adds an isolated read-only adapter, separate from
all installed entry points. It publishes the current real model, an explicit
bridge capability manifest and genuine snapshot runtime settings. It starts no
local backend and does not substitute local account/config/skills data for
cloud data. The initial experiment refused missing history. The 22 October
2026 compatibility update completes an incomplete legacy snapshot through the
existing owner with one read-only history request and a 20-second deadline;
already complete snapshots need no additional history request. This does not
create an owner or resume a cloud thread. A genuine explicit empty
`modelProvider` is preserved, as permitted by the official protocol; absent or
nonstring provider metadata still fails validation.

The unmodified Windows CLI was actually run against this adapter in an
isolated PTY, with no model prompt. It completed initialize, account/read and
thread/read, then reported "No saved session found" before resume/bootstrap.
The server reported no rejected RPC; the native connection remained ready.
Source inspection explains a concrete client-side blocker: `Thread.cwd` is
`AbsolutePathBuf`, and the Windows client's typed JSON decode has no path base
or cross-platform conversion. The genuine `/workspace/...` cloud path is not
an absolute Windows path. The lookup catches this decode failure and displays
the generic missing-session error. `Thread.path: null` is supported and is not
the cause; inserting a fictitious rollout path would not solve the issue.
JSON schema only constrains the cwd to a string, so it did not detect this
platform-specific Rust constraint. Changing `platformOs` or `--cd` cannot fix
the typed response decode. No installation or runtime paths were changed.

The user requires the original Windows CLI without WSL or a source-derived
build. A subsequent bridge-only experiment overcame the typed path rejection
for a narrowly scoped text observer, as described next. No CLI binary, source,
Desktop installation, startup, shortcut or credentials were modified.

## Original Windows CLI: live text observation verified

On 2026-10-21, a synthetic A/B probe used the same unmodified Windows CLI
0.163.0-alpha.10.2. Original POSIX cwd failed with the generic missing-session
error. A separate adapter encoded only the protocol cwd and workspace-root
fields as `\\?\CST-CLOUD-<random UUID>\workspace\...`. The CLI then resumed
and rendered the synthetic history. This is a connection-local path encoding,
not a local workspace, drive, network share or mounted filesystem.

The real, already authorized cloud test was then opened through that adapter.
The CLI displayed its actual title, real model, existing user/assistant history
and runtime settings. A read-only QueryDosDevice check confirmed the randomly
chosen namespace was unregistered before launch. The child used an isolated
local configuration directory; no directory or device was created for the
encoded cloud path. Its original POSIX cwd was disclosed before launching.
This experiment must not be described as proving zero local filesystem API
calls: the CLI still has local path probes, and no process-level I/O trace was
collected.

One additional authorized fixed-marker submission, **G**, was made through the
official ChatGPT tool while this original CLI was attached. The CLI visibly
showed the new user message, working state, three streamed text deltas, the
exact expected reply and completion. The bridge recorded one genuine started
and completed native turn, two started/completed items, and no control calls.
An independent read of the original ChatGPT conversation confirmed the same
G prompt and answer after one targeted cache invalidation. The first summary
read was stale; it was not treated as a delivery failure or retried send.

This verifies **original Windows CLI live text observation**, not terminal
submission or full bidirectional control. The experiment was bounded and its
own terminal process and connections closed normally. Installed CST entry
points were not changed. Unsupported skills/config/plugin operations still
produce errors in the native UI; this is not a release-ready observer mode.

The path representation has additional limits:

- The CLI uses local Git-root and file-search checks even for remote sessions.
  The probe accepts no file operations, attachments, approval replies or
  execution controls, and never creates a filesystem mapping.
- Generic verbatim namespaces degrade to opaque `PathUri` values. They do not
  preserve general filesystem hierarchy or permission semantics.
- WorkspaceWrite permissions derive protected paths through local filesystem
  probes. The tested cloud session genuinely used dangerFullAccess; its actual
  permissions were preserved, not replaced to fit the adapter.
- Only explicit protocol path fields are converted. Model text, prompt text,
  commands, diffs and tool arguments must never be recursively rewritten.
  General paths, guardian items, files and permission profiles remain outside
  the research adapter's narrow allowlist.

A second source review of the available sending contracts found that the
official tool call ID is dropped before the cloud submission generates its
fresh user-message UUID. Internal message/stream IDs are not returned by the
public tool, existing IPC, actions or tool logs. The F cross-history identity
join is real but cannot associate a particular tool invocation with a message
under concurrency. Native cloud sends still bypass the original ChatGPT
history in the verified D path. Therefore neither route establishes
faithful native CLI start/steer/queue behavior. Stopping was subsequently
verified separately below. No successful turn receipt
is manufactured from text matching, timing or an uncorrelated new turn.

## Original Windows CLI: guarded cloud interruption verified

The separate `cloud-interrupt-control.mjs` helper sends one user-stop request
for an explicitly identified active turn. It requires the original durable
owner, a current snapshot and an exact match between the native user item's
client ID and the independently read frontend message ID. The new
`allowExperimentalDurableInterrupt` flag authorizes only interruption; it
does not enable start, steer, settings changes or queue replacement.

The helper checks both the genuine owner response and a newer native state
for the same interrupted turn. It never retries an ambiguous write and
rejects repeat attempts for that turn on the same client. Owner loss, resync,
timeout or a contradictory receipt cannot become a confirmed success.
Its result explicitly leaves backend and frontend confirmation false:
Desktop can update native state after its backend interrupt returns, so
follower state alone is not an independent read of the backend or ChatGPT.

Two authorized tests exercised a 45-second waiting task in the dedicated chat:

- **H, direct helper:** one interrupt stopped the exact native turn after
  about 29 seconds. Independent native and frontend reads confirmed the
  interrupted turn and the original ChatGPT thread returning to idle.
  This exposed a conservative confirmation bug: the turn could already be
  interrupted while runtime status was still active. The helper now accepts
  that transition, with a regression test. H was not replayed.
- **I, original CLI Esc:** the unmodified Windows CLI attached through the
  experimental path proxy. One Esc sent to that isolated terminal's input
  generated one native `turn/interrupt`. The guarded callback returned a
  matching receipt and state, and the CLI displayed "Conversation interrupted".
  An independent backend read confirmed the exact turn interrupted after
  about 17 seconds; the original ChatGPT thread changed from active to idle.
  Its natural-completion marker was absent. The CLI then exited normally.

These tests verify cancellation of the execution turn, not a process-level
trace proving that every remote child process was killed. The proxy accepts
only the attached thread and selected turn, and requires an explicit callback.
Its underlying cloud bridge remains read-only; all other controls remain
denied. Command execution items are rendered as received, never run locally.
No Desktop installation, startup, account settings or credentials were changed.

## Admission sender: native receipt does not establish frontend persistence

Source inspection identified another genuine default/user route:
`context.useUserMessageAdmission: true`, which invokes `turn/addUserMessage`.
It accepts a caller-supplied message ID and can return a real turn with an
admission outcome. It does not require relabeling the chat as aeon.
The separate `allowExperimentalDurableAdmission` flag permits only this
explicit candidate, with matching request/restore IDs and inherited settings.
It is off by default and cannot enable ordinary sends, steer or interruption.

Authorized test **J** made exactly one request. It returned a real native
turn and `admissionOutcome: started`. An independent backend read confirmed
the expected completed response, and runtime settings were unchanged.
The original ChatGPT conversation still contained only the earlier I/H/G
messages after targeted invalidation and a later read; J was absent.
The follower also did not expose the supplied client ID on a matching user
item during the observation window. No second send was attempted.

Thus J provides a genuine native admission receipt but does not solve
original ChatGPT history persistence. The inspected contract also lacks an
established start-only, steer-only or queue operation. Product cloud sending
remains disabled. No linkage field or message receipt is invented.

## Development modules

`cloud-app-tools.mjs` contains the restricted official-executor transport.
Its cloud write path is disabled by default. Experimental writes require both
an explicitly authorized target allowlist and `sendCapability: 'send-or-steer'`;
the caller must account for the possible steering behavior described above.
The module is separate from the existing local bridge. Three fixed-message
experiments were authorized and performed only in a dedicated cloud test chat:

- Test A sent through this module and was independently read through the
  official app tool.
- Test B sent through the official app tool and was read by a new module
  connection, exercising reconnection.
- Test C observed an idle thread whose returned history still lacked the new
  messages. After one targeted cache invalidation, a read returned new user
  and assistant message IDs with the exact expected marker in 3.623 seconds,
  28.673 seconds after the send acknowledgement and before the natural
  one-minute cache expiry. A separate official app-tool read confirmed the
  same IDs. The helper was archived, with no remaining plugin process observed.

All three produced new user and assistant message IDs with the expected
response. These are controlled observations, not latency guarantees or a
general unique-delivery receipt contract.

`cloud-history-refresh.mjs` exposes the separate experimental
`markCloudHistoryStale({ conversationId, transportFactory, timeoutMs })` helper.
The caller must supply `verifiedDesktopTransport(...)` or an equivalent
transport that verifies the Desktop peer on the same handle. The helper
registers its own client identity through normal initialization, then sends
only `query-cache-invalidate` for the single UUID key
`['chatgpt-conversation', conversationId]`, with `reset: false`. It does not
discover or claim a thread owner, send a prompt, or control generation.

This uses an internal coordination protocol observed in the installed
Desktop build, not a publicly supported, stable refresh API. Its result
`{ invalidationSent: true, refreshConfirmed: false }` confirms only a local
write followed by normal transport closure. There is no acknowledgement that the renderer
processed it or that a server refresh completed. A subsequent history read
is required, and a read already in flight can still return older data.
The helper bounds connection, initialization, writing and shutdown with one
deadline and closes only its own transport. It remains separate from
`CloudAppToolsClient` and all product entry points. This is snapshot refresh,
not token streaming or native CLI attachment.

`cloud-conversation.mjs` is a pure normalizer for the separately documented
ChatGPT conversation-graph format. It retains real message IDs and selected
branches, reports unsupported content and missing runtime fields, and does
not manufacture a CLI resume response. The app-tools summary is not this raw
graph format; the two must not be confused.

Direct HTTP access to the web conversation endpoint encountered a verification
challenge during the experiment. That route was stopped; there is no challenge
emulation or browser-header impersonation in this implementation.

## Validation

The full JavaScript suite passed all 245 tests after the durable follower,
native metadata and read-only cloud adapter changes, including 18 cloud app-tool
transport tests, 8 conversation-graph tests and 9 history-refresh tests.
Those new tests use synthetic data. Three additional transport lifecycle tests
cover graceful EOF, delayed helper failure and cancellation. The proxy now
waits for its helper's exit status so stdout EOF cannot hide a failed exit.
A subsequent live, prompt-free invalidation verified normal shutdown with
this fix; it did not repeat Test C's send or freshness measurement. The
separate live check verified read-only access, repeat reads with stable message
IDs, helper archival and executor cleanup. Subsequent authorized tests verified
the two sending/reading directions described above, recovery after
reconnection, and the Test C targeted history refresh. They did not validate
native streaming, stopping, queueing, visible Desktop rendering or official
CLI attachment. Later D/F experiments verified native streaming and page-away
observation; G verified original Windows CLI live display. H/I then verified
guarded interruption, including the real CLI Esc path, with independent
native and frontend readback. J verified native admission but failed the
original-frontend persistence requirement. None establishes production-ready
cloud control.

After the interrupt/admission changes, the full JavaScript suite passed
**272/272 tests** using `node --test --test-isolation=none test/*.test.mjs`,
including existing local-session and history paging regressions. A separate
source review found no material issue in the narrow gates, interruption
helper or experimental CLI callback. No installer or installed entry point
was changed. Experimental CLI/helper processes and their own connections
closed after the tests.

## Release gate

Before enabling a cloud entry in the product, verify a genuine transport for
the required controls, accurate runtime metadata or an officially supported
CLI representation, the active-chat selection mechanism, message receipts,
and reconnection behavior. A successful read alone does not satisfy this gate.

The remaining gaps are separate; solving one does not imply the others:

| Requirement | Current evidence |
| --- | --- |
| Preserve the original Windows CLI, without WSL or Desktop changes | Verified in G/I for the narrow text/command-display path |
| Observe the same cloud execution live | Verified after the existing durable owner is available |
| Stop that exact execution from the CLI | Verified in I and in K with automatic frontend identity confirmation |
| Send into the original ChatGPT conversation with a causal receipt | Not available on the examined independent interfaces; D/J only persist natively |
| Preserve caller-selected start, steer and queue semantics | Not established by the official frontend send-or-steer tool |
| Identify the currently displayed cloud chat automatically | Exact external ID unavailable; bounded title matching or an inspected private association, revalidated against fresh message IDs |
| Resolve arbitrary frontend/native conversation identities | No general authoritative pair returned by the available read projections |
| Attach when a native durable owner does not already exist | Authorized temporary normal navigation and guarded Back verified on the dedicated chat; no independent background activation interface |
| Support arbitrary cloud paths, items and permission profiles | The Windows projection intentionally handles only the tested subset |

The latest sender investigation traced the actual frontend submission module
and the Electron AppHost/AppView request route. Tool call ID correlation is
preserved through the entire outer request/response router. The generated
frontend message ID is omitted inside the sender wrapper before its result
reaches that router. Retaining extra outer request metadata cannot recover it.
The richer frontend submission function is a renderer-local export, not an
externally registered action. The AppHost port requires the genuine registered
renderer; CST does not impersonate it or inject a callback.

Normal followers do help retain an already existing owner when the user leaves
its page: the inspected inactivity tracker explicitly excludes owners with
stream followers. This is not owner creation or a promise of permanent
availability. A lost owner still closes the attachment without replaying writes.

## Reusable Windows attachment under development

`cloud-windows-cli-proxy.mjs` moves the tested protocol path encoding out of
the one-off runner. It has its own authenticated loopback endpoint and exposes
real POSIX state to its caller; only explicit wire path fields are encoded.
Unknown items, changed paths and unsupported settings fail visibly. Its default
capability is read-only; an explicit interrupt callback cannot authorize other
writes.

`cloud-interrupt-controller.mjs` replaces the manual experiment gate with an
official frontend read. Before sending a stop, it verifies the exact native
user client ID exists once in the selected active ChatGPT conversation and
rechecks the owner, active turn and current input. It does not infer execution
order from summary group order, or infer identity from text and timestamps.
Late reads after cancellation or timeout cannot result in a write. The result
reports this as frontend preflight, not proof that the frontend has stopped.

`cloud-windows-attachment.mjs` composes the reader bridge, optional interrupt-only
follower, confirmation controller and Windows proxy. Closing it releases only
its own resources; it never interrupts the cloud task as a cleanup action.
Connections that finish setup after cancellation are closed immediately.
This assembly is still separate from the tray, shortcut and installer.

The integrated **K** test used these repository modules with the original
Windows CLI and the dedicated authorized cloud chat. One Esc produced one
interrupt request. The controller performed one official frontend preflight
read, matched the exact current input ID and obtained a genuine native stop
receipt. An independent backend read showed the selected turn interrupted
after 16.259 seconds; an independent frontend read showed the same ChatGPT
message and an idle conversation. No natural-completion reply appeared.
The CLI exited with code 0 and the official reader helper was archived.
No manual gate file authorized this stop.

Review found and fixed an initial 1 MiB upstream history limit. A real-socket
test now transfers a 5.5 MB history unchanged through both read and resume.
The upstream frame ceiling matches the 256 MiB Desktop protocol bound.
Both directions have bounded pending bytes; the response direction allows
one large history frame separately from its normal 4 MiB queue budget.
A slow consumer exceeding that budget closes the connection with a recorded
direction and reason, without truncating history, dropping events or retrying
operations. Parallel large responses arriving during an existing backlog
can still close the attachment; that case is not advertised as supported.

The full JavaScript suite now passes **322/322 tests**. Independent reviews
covered the Windows proxy and the frontend confirmation/lifecycle assembly.
Cancellation during resource adoption, reentrant close, late connections and
cleanup failures all have regression coverage.

A separate background-only Windows accessibility inspection also did not
find a reliable current cloud conversation ID. The current document exposed
only the app shell URL; sidebar items exposed titles without chat links or
selected IDs. The driver did not certify that every possible underlying UIA
property was enumerated, so this is a limitation of the inspected snapshot,
not a claim that all future accessibility routes are impossible. No page
switch, input or application startup was used for that inspection.

## Upstream follow-up

The official app-server documentation confirms the CLI's `--remote` transport
and normal app-server protocol, but does not document attaching an existing
ChatGPT Work conversation through that option:
https://learn.chatgpt.com/docs/app-server

Static comparison with upstream commit
`2744e8686c3defaa96f7aff6c51a9df961c51224` (2026-10-21) found no new
cloud-managed or observer CLI entry. The required resume settings remain;
new multi-backend session bookkeeping still uses native `AppServerSession`
objects. `thread/sample` runs a response in an ephemeral fork and is not an
attachment mechanism. No installed CLI or Desktop was upgraded for this check.

A follow-up on the same upstream commit also checked `codex agents`,
`codex queue` and `--code-mode-host`. The first lists threads on its connected
app-server; the second calls that server's `thread/queue/add`. Neither supplies
an independent ChatGPT account-wide conversation discovery or frontend send
service. Code Mode host is the JavaScript execution service used by
`functions.exec`, not a conversation endpoint. These options do not resolve
the missing frontend message receipt or conversation identity mapping.

The official Work documentation separately states that local computer access
with Work Cloud does not combine Work history with Codex history. This is
consistent with the observed boundary, but is not proof that every possible
future integration is unavailable. No additional live send was justified by
this check:
https://learn.chatgpt.com/docs/cli/reference
https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview

## Authorized temporary navigation and return (22 October 2026)

The current-title shortcut now handles an exact `NO_OWNER` with a temporary
normal Desktop navigation, explicitly authorized by the user. Existing owners
take the immediate path. Manual selection, explicit IDs without a captured
source window, ambiguous title matches and other connection failures do not
authorize automatic page navigation. Title selection remains a bounded
directory heuristic, not an authoritative frontend/native mapping.

`cloud-owner-activation.mjs` rechecks the original process, HWND, process start,
document and exact title. `Desktop-Context.exe` now also samples the Windows
last-input tick before and after its observation. Any changed input or page
before dispatch prevents the excursion. The official navigator is bound only
to the selected native ID. Discovery may retry up to four times; navigation is
never replayed. The retained follower keeps the connection while returning.

The current official navigation route pushes one history entry. Returning uses
the application's actual top-left Back button, not a guessed frontend ID.
The separate `--back` helper mode checks the exact window/page/input snapshot
again, finds one enabled UIA Button/Invoke in the bounded chrome region and
invokes once. No focus manipulation or global keystrokes are used. Input/page
changes, ambiguous buttons or unknown outcomes suppress return; an attached
terminal can remain usable. Cancellation closes undelivered resources.

43 orchestration/title-context/terminal tests, 37 reader/app-tools tests, seven
C# fixture groups and installer staging checks passed. A live dedicated-chat
probe injected the initial missing-owner error (to avoid disrupting an existing
owner) and then used real official navigation, real read-only attachment and
real guarded Back. The round trip took 8,950 ms, preserved the last-input epoch,
and screenshot readback confirmed the original ordinary ChatGPT view and
scroll position. This is live recovery-path validation with an injected initial
condition, not a fresh-process cold-start acceptance claim.

## Untitled native counterparts and report history (22 October 2026)

A separately inspected cloud report exposed a frontend title but a null native
title. Exact title matching could not select its native counterpart. Reading
both projections and inspecting their normal Desktop pages established the
candidate pair. Its latest native user item `clientId` and turn
`params.clientUserMessageId` both matched the frontend's latest user message ID.
This demonstrates shared message ancestry; it is not proof of global fork
uniqueness, and does not supply a resolver for arbitrary conversations.

`cloud-identity-links.mjs` accepts a small, strictly validated private association
file in CST's own data directory. The inspected pair was enrolled locally;
conversation IDs and the association file are excluded from the installer.
Each use still requires a unique exact frontend title, a fresh official
frontend read, and a complete latest native user boundary with both client IDs
matching. Incomplete, ambiguous or changed evidence fails visibly. Unknown
untitled conversations are not automatically guessed. The frontend title is
used only for the read-only terminal label; no official conversation is renamed.

The inspected report also contained `fileChange` and `imageView` history items
that the Windows projection previously rejected. They now retain their original
types, IDs and payloads after strict field and protocol-schema validation.
Only bounded single-slash POSIX cloud paths are accepted, including rename
destinations. Windows, UNC, URI, relative and control-character paths remain
rejected. Source inspection of the pinned Windows CLI confirmed that image-view
history displays a path label and file-change history renders the supplied diff.
For these POSIX paths, Windows path display returns before local repository
inspection. No files or image pixels are fetched, and body links remain inert
under the terminal's read-only input filter.

Validation passed 97 identity/recovery/terminal/read-only tests and 32 Windows
proxy tests, plus installer staging and the installed startup check. An actual
installed original Windows CLI displayed the inspected report, its frontend
title and the permanent read-only banner in 10,560 ms. Native identity matched,
and the recorded request set contained no writes. The test closed only its own
CLI and follower after observing the content.

The Desktop was locked during that final test. Its already inspected title
context was injected, and navigation was disabled for the test. This verifies
the real installed reader, association, snapshot, projection and CLI display;
it does not establish live hotkey capture or automatic return for this newly
associated untitled conversation. The earlier dedicated-chat navigation/return
validation remains the UI evidence for the recovery path. If page or input state
changes during the excursion, the implementation deliberately skips Back.

## General untitled discovery and live-turn display (23 October 2026)

A second untitled cloud chat demonstrated that the private association added
above was not a general resolver. The shortcut diagnostic also showed a missing
title context. Read-only title capture now tolerates incidental input while
requiring the same process, window, document and title on both observations.
Its timeout is four seconds, and the tray records a bounded reason and duration.
Navigation and Back retain their separate last-input checks.

Without an enrolled hint or an exact native title, the resolver reads the last
four turns of the selected frontend and each recent/pinned durable candidate,
at most 4096 characters per item. Two complete, ordered user messages nominate
one candidate; duplicate matches, failed reads, truncation and stale frontend
IDs fail closed. The scan is bounded to 64 candidates, three concurrent reads
through one official helper, and 18 seconds excluding startup/list latency.
The suggestion is not persisted. A fresh frontend message ID must match the
latest canonical native user receipt before history or presence is exposed.
This remains bounded directory evidence, not proof of global fork uniqueness.
The manual list now includes readable frontend names before native records.

Native continuation can contain several user messages in one turn. The latest
admitted client ID is checked while preserving the initial user/root-ID
invariant. A server-started live turn has a real turn UUID and start timestamp
but no pagination fields yet; its fresh frontend receipt can verify that
representation, including its completed/idle form. Conflicting supplied root
IDs, noncanonical tails, unresolved steering and changed receipts still fail.

The live chat also exposed a Desktop-only `receiverThreads` cache attached to
collaboration history. Source inspection confirmed the official wire record
already carries `receiverThreadIds`. The adapter validates and omits only the
extra loaded-thread cache, retaining the collaboration item and its original
IDs/status/content. It does not expose child-chat cached histories to the CLI.

Untitled native pages can transition from a generic loading title to the first
plain-text prompt, truncated by Desktop to 60 UTF-16 code units. Guarded Back
accepts that exact verified transition; rich Markdown title derivations remain
unresolved. If Desktop resolves an already-known native target to the unchanged
Work page, no Back is dispatched. User input or unrelated page changes still
win over automatic navigation.

Live installed validation used actual title capture, official read tools,
native IPC and the unmodified Windows CLI. The previously unresolved chat was
automatically selected without adding a private association; its frontend
title, content and permanent read-only banner displayed in 24,948 ms. The
request ledger contained no writes. A new user message arrived during an
earlier attempt and the changed receipt correctly prevented display; a fresh
attempt verified the active turn and succeeded. Only the test-owned CLI and
follower were closed.

A real initial missing-owner attempt opened the native view and established
the connection. Subsequent recovery tests injected that initial condition to
preserve the now-existing owner. Actual navigation then kept the original Work
page, confirmed by UIA and screenshot, with an unchanged input epoch; therefore
Back was correctly unnecessary. The generic-to-generated-title Back transition
has regression coverage but has not yet been repeated on a fresh cold owner.
The physical shortcut and the new tray timeout still need a newly started tray
acceptance; the running tray was deliberately not restarted over user terminals.

The full 507-test JavaScript suite and Windows/PowerShell checks passed, followed
by 48 targeted recovery/terminal tests after adding unchanged-page handling and
the local-title conflict guard. No ChatGPT installation, global configuration,
credentials, messages or manually enrolled association was modified.

## Keep connecting when the user selects the terminal (23 October 2026)

The user confirmed the previous untitled discovery fix through the physical
shortcut: the intended read-only terminal opened with the correct title and
content. A subsequent report exposed an unrelated recovery guard: it compared
Windows' global last-input tick with the value captured before opening the
terminal. Clicking that new terminal or using another application changed the
tick and could reject a valid missing-owner recovery as `CLOUD_PAGE_CHANGED`.

Recovery now checks the captured Desktop process generation, window, document
and expected title independently of global input activity. Selection still
starts from the foreground Desktop window, and leaving that window before the
terminal appears cancels the initial capture. Once the terminal exists, moving
focus to it or another application does not cancel connection or disqualify the
return attempt. Actual source-page changes still prevent pending navigation;
changes after navigation prevent Back without discarding a usable connection.

Back receives the latest page/input snapshot. Its existing native one-shot
check remains: input arriving during that short final check can suppress Back,
but never causes connection failure or a repeated navigation attempt. This
supersedes the earlier requirement for no global input throughout recovery.
No application focus is requested by the recovery module.

All 521 JavaScript tests passed, including 69 focused recovery, terminal and
context tests. Regression cases advance global input before recovery, during
helper preparation, forward navigation and attachment, and at every snapshot;
they check both titled and message-linked untitled chats. Changed page/window
identities still block navigation or return, and a native Back refusal retains
the attachment. These are automated behavioral checks; physical focus switching
during a new cold-owner connection still needs live acceptance. The change is
loaded by new terminals and does not require restarting Desktop or the tray.

## Compaction recovery and visible-text copying (23 October 2026)

The user accepted the focus fix, then reported two cloud viewers stuck at
"Automatic reconnect could not restore this session" after continuing in
Desktop. Background snapshots confirmed both failures. Independent read-only
attachments reproduced the same cause: Desktop contextCompaction records carry
`completed` and `source` fields outside the pinned official wire item's id/type
shape. The proxy rejected the live marker and every later full resume containing
it. Those two display/lifecycle fields are now validated and omitted from the
wire clone; the original marker, IDs and actual lifecycle events are retained.
Unknown fields and malformed metadata still fail closed.

Both real affected histories then passed full resume and a second connection
through the Windows proxy, with zero projection errors. A real-socket regression
also covers compaction, reconnection and subsequent assistant deltas. This does
not claim recovery from every possible upstream disconnection or format change.

Read-only mouse capture previously swallowed body drag gestures. The wrapper
now handles visible-body selection itself, leaving the original CLI and its
input restrictions intact. It snapshots displayed cells while selected, supports
reverse and multiline ranges and whole wide characters, and uses Ctrl+C or a
right click to copy. Esc, paging and resize release selection. The bounded
Windows clipboard writer passes UTF-16LE text to clip.exe over stdin, without
a shell, clipboard reads or a resident helper. Child OSC clipboard commands,
pasted controls, sending and interruption remain blocked. A footer explains the
copy gestures; ordinary drag selection requires no modifier key.

All 527 JavaScript tests passed. Hidden test-owned ConPTY viewers then ran the
installed, unmodified Windows CLI against both affected native IDs and displayed
the expected content, session titles and read-only banner in 3035 ms and 2064 ms.
Those measurements start with an explicit, already known native ID; they do not
include automatic cloud discovery. Only the test viewers and followers closed.
The user subsequently confirmed that physical drag/copy works.

## Linked cloud receipt validation after Continue (23 October 2026)

That acceptance also exposed a separate connection rejection on a previously
linked chat. Live read-only inspection of both affected chats showed exact
frontend/native latest client-message ID agreement. Their completed canonical
turns had no paginated-history fields or root receipt yet. Discovery already
accepted this validated live shape, but the previously linked path required
the older paginated form and rejected both valid sessions.

Both candidate paths now use the same current-message checks, including user
continuation inside one turn. The canonical latest exhausted boundary, durable
identity, live status/time/server turn ID, complete paginated items when present,
unique admitted client IDs and latest frontend receipt are still required.
Conflicting supplied root receipts, duplicates, unresolved steering, optimistic
turns and incomplete history remain rejected. No link was added or altered.

All 530 JavaScript tests passed. Fresh live checks accepted both affected
histories through both paths; earlier checks against those same message IDs
reproduced rejection only in the linked path. The user then confirmed that the
physical shortcut opened the intended chat with correct content and working
ordinary drag/copy. New terminals load the correction without restarting
Desktop or the tray.

## Bounded discovery reads (23 October 2026)

Discovery now requests two recent turns first, keeping the previous four-turn
limit as a fallback when fewer than two user messages are available. It avoids
that expansion for an exhausted history or a latest user input that already
cannot match. Every listed native candidate is still checked, possible matches
still require complete ordered text, and display still requires a fresh frontend
receipt and the native snapshot's exact latest admitted client-message ID.
Previously enrolled candidates read their frontend and native summaries in
parallel; neither result alone permits attachment or display.

Sequential live probes on the same account observed discovery at 14,207 ms
before the change and 12,717 ms after it, both identifying the expected native
session. The latter made 18 reads rather than 17 because one sparse summary
needed expansion. These are individual timings, with cache/network variance,
not a guaranteed improvement or end-to-end shortcut latency. Helper startup
and the fresh directory query remain additional costs. The candidate concurrency
limit remains three. No persistent history/index cache or resident helper was
added; the earlier cache idea remains unimplemented.

All 533 JavaScript tests passed, including sparse/exhausted summaries, a
different or truncated latest input, and overlapping linked reads that cannot
open a viewer before both complete.

## Recent successful candidate fast path (25 October 2026)

Repeated opens can reuse a successful candidate for up to five minutes within
the same tray run. Enrollment happens only after full discovery and canonical
native receipt validation, not when text comparison merely suggests a match.
The bounded, atomically replaced store holds at most 64 entries in 32 KiB:
frontend/native/client-message IDs, a directory digest and the original time.
It contains no titles, message text or credentials. Hits do not renew expiry.

Every attempt still obtains a fresh directory. The competing cloud candidates
must be idle with unchanged update stamps; added/removed/renamed candidates,
conflicting directory rows, missing metadata or another active cloud candidate
disable reuse. The current frontend receipt must equal the enrolled receipt.
Two parallel summary reads are followed by a short-lived, read-only native
attachment that verifies the canonical latest message. Only then can normal
display attachment proceed, which verifies the receipt again. A failed probe
discards the hint and runs full discovery. A receipt changing between probe and
display closes the attempt and retries full discovery once, with reuse disabled.
An unavailable owner also falls back to the existing recovery path. No cache
failure publishes candidate history or grants cloud control/navigation access.

This is a bounded optimization of the existing recent/pinned directory scope,
not proof of account-wide fork uniqueness. Cache lookup requires idle update
metadata for competitors; it does not cache or relax the final message proof.
The six-second fast-path deadline bounds added wait if it cannot verify a hint.
There is no new resident process and no Desktop/global configuration change.

All 541 JavaScript tests and the complete Windows/PowerShell suite passed.
Tests cover repeated opens without a broad scan, enrollment after proof,
non-renewing expiry, changed messages/directories, active competitors, timeout,
late completion, malformed/unwritable storage and cleanup before retry.
The first live benchmark attempt stopped at NO_OWNER before CLI display because
the chosen cloud execution view was not attached in Desktop. No page was switched
and no message was sent; an end-to-end performance claim remains pending a live
owner and the user's installed shortcut acceptance.


## 2026-10-26: cache-free startup and actual-terminal observations

The five-minute recent-candidate optimization above is retired. Production no
longer imports or distributes its module. Existing private files are untouched;
they are not consumed or updated by the new launcher.

Exact native-ID entry points now validate the authoritative durable read-only
attachment directly, without creating an app-tools executor or reading a redundant
summary. Frontend-title discovery retains its current title/content/message-ID
checks. Bounded inspection of Desktop 26.1016.8622.0 did not establish a new usable
external frontend-to-executor relation API. The `codexThreadId` occurrences
examined belong to executor metadata and realtime voice handoff tracking, not a
general external mapping API. No speculative probing was added to startup.

The lookup-only executor closes asynchronously after the native CLI's first
rendered composer; final cleanup joins the same promise. It is not needed for
ongoing native streaming, paging or the independent return-to-Desktop button.
A failed archival/cleanup result is diagnostic and cannot close a healthy viewer.

`terminal-status.json` is one sanitized, coalesced snapshot per actual terminal,
including local terminals. No server, control endpoint, transcript, title,
conversation ID or connection credential is added. It is a last observation,
not a process heartbeat or a claim that the window is foreground. First rendered
composer and first verified content are deliberately separate measurements.

The paired benchmark, limitations and resource checks are recorded in
[CLOUD-FIRST-OPEN-ACCEPTANCE.md](CLOUD-FIRST-OPEN-ACCEPTANCE.md).
