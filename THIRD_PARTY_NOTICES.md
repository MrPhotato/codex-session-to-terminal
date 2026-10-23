# Third-party dependencies

The source distribution contains Codex Session to Terminal's own code and assets. The Windows installer additionally bundles the complete official Node.js and PowerShell portable distributions listed below. It does not bundle the official Desktop application or the Codex CLI.

| Bundled runtime | Locked version | License location in the installed application |
| --- | --- | --- |
| Node.js | `24.22.0` | `runtime/node/LICENSE` and the licenses/notices in the bundled npm dependencies |
| PowerShell | `7.6.5` | `runtime/powershell/LICENSE.txt`, `ThirdPartyNotices.txt`, and module-specific notices |

The full upstream runtime distributions and their license files are retained. Download URLs, SHA256 values, and official verification sources are recorded in `installer/runtime-lock.json`. These runtime distributions include third-party components with their own license terms; their complete notices apply.

| Package | Locked version | Package-declared license |
| --- | --- | --- |
| `@openai/codex` and its Windows platform package | `0.163.0-alpha.10.2` | Apache-2.0 |
| `ws` | `8.22.0` | MIT |
| `ajv` | `8.17.1` | MIT |
| `node-pty` | `1.1.0` | MIT (including bundled Windows ConPTY components and their upstream notices) |
| `@xterm/headless` | `6.0.0` | MIT |

The protocol schemas in `protocol-schema/` were generated from the official Codex app-server interface used for this adapter and are distributed under the upstream Apache-2.0 license. The schemas validate data shapes; they do not imply official support for Desktop's internal IPC.

Application dependencies are downloaded directly from the public npm registry when the installed application's first Start runs `npm ci`, or when a source user runs it manually. The lockfile verifies upstream package integrity. Preserve and follow the license and notice files distributed with each dependency. Some native components shipped by upstream packages have additional notices or licenses; the top-level package license is not a substitute for those notices.

The installer is built using Inno Setup 7.1.0. Its upstream license is retained as `licenses/INNO-SETUP-LICENSE.txt` in binary distributions. Inno Setup is a build dependency, not an additional application installed on the end user's computer.

ChatGPT, Codex, OpenAI, Windows, and Windows Terminal are names of their respective products or owners. References identify interoperability targets and do not imply affiliation or endorsement.
