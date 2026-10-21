# Third-party notices

Clax has not copied or modified source code from Codex or OpenClaw. Its small local runtime is independently implemented; the names do not indicate official affiliation or an embedded OpenClaw runtime.

The following official sources informed the adapter boundaries and interaction design:

- [openai/codex](https://github.com/openai/codex), Apache-2.0: tool activities, approval UX, session/usage events; [app-server protocol](https://developers.openai.com/codex/app-server) was evaluated. No Codex binary, code, login flow or subscription usage is bundled or claimed.
- [openclaw/openclaw](https://github.com/openclaw/openclaw), MIT: provider/runtime separation, session context, local memory and Markdown skills; [agent-loop](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md) and [model providers](https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-providers.md) were reviewed. No Gateway is included.
- Memory implementation references OpenClaw commit `467fc82c4fd96e6dd55b3d0a6c1559dcf7d0b291`: [compaction](https://github.com/openclaw/openclaw/blob/467fc82c4fd96e6dd55b3d0a6c1559dcf7d0b291/docs/concepts/compaction.md), [layered memory](https://github.com/openclaw/openclaw/blob/467fc82c4fd96e6dd55b3d0a6c1559dcf7d0b291/docs/concepts/memory.md), paired tool boundaries, pre-compaction persistence and bounded search. These patterns are independently implemented without copying runtime code.
- [composio-community/open-dot](https://github.com/composio-community/open-dot), commit `f838e17cf5c3a88ade5ceea54680a8145d048c1d`: [remember/forget tools](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/agent/tools.ts) informed explicit memory updates. No Composio service or Open Dot code is bundled.

Dependencies are installed unmodified by pnpm; their licenses remain in `node_modules`:

| Dependency | License | Used for |
| --- | --- | --- |
| Electron | MIT | Desktop, tray, IPC, safeStorage |
| React / React DOM | MIT | Renderer |
| Vite / electron-vite / React Vite plugin | MIT | Build and local development |
| TypeScript | Apache-2.0 | Type checking |
| tsx | MIT | Test scripts |
| react-markdown / remark-gfm | MIT | Markdown rendering |
| lucide-react | ISC | Icons |
| diff | BSD-3-Clause | Applying and producing unified diffs |
| zod | MIT | IPC validation |
| quickjs-emscripten | MIT | Isolated JavaScript plugin execution |
| ajv | MIT | Plugin input schema validation |
| undici | MIT | Controlled HTTPS transport |
| ipaddr.js | MIT | Plugin destination address checks |
| Playwright | Apache-2.0 | Desktop integration verification |

SQLite is provided by Node/Electron's built-in `node:sqlite`. Electron's own bundled third-party notices are distributed with its binary. See `pnpm-lock.yaml` for exact dependency versions and the packages' LICENSE files for complete terms.
