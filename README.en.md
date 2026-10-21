# Clax

**A Personal Agent Harness that can evolve its own code and capabilities.**

[简体中文](README.md) · [English](README.en.md)

Clax is a **personal agent harness that can iterate on its own source code**. It brings model access, tool execution, long-term memory, and task control into an extensible framework, with a personal desktop agent as its interface.

Set the working directory to the Clax source tree, and you can ask it to **read its own implementation, modify its own source, add tests, and run builds**. It can develop features, change its interface, and improve its runtime in response to your instructions. Changes can be tracked in Git; core source updates take effect after rebuilding and restarting, while tool plugins can be installed and used during a running session.

For everyday work, a keyboard shortcut opens its translucent white window for conversation, research, and project tasks. It keeps your conversations and working context, builds lasting memory of preferences and project decisions, and lets you steer, pause, or stop work along the way.

### What Clax can do

| Capability | What it means for your work |
| --- | --- |
| Iterate on its own source | Work in the Clax source tree to change its core logic, tools, and interface, then run tests and builds for the next version. |
| Always within reach | Open with Option / Alt + C. Tasks can keep running while the window is hidden. |
| Your choice of models | Access Claude, GPT, DeepSeek, Gemini, and other models through OpenRouter. Choose supported reasoning levels and check your balance and usage by model. |
| Control during execution | Read streaming replies, add instructions with Steer, and pause, resume, or stop a task. |
| Context that carries forward | Compact long conversations while keeping the originals, and retrieve preferences, facts, and project decisions from long-term memory. |
| Web and local tools | Search the web with source links, read and edit workspace files, and run shell commands. |
| Tools that can grow | Describe a tool you need and let the agent write, test, and install a plugin. Enable, disable, or roll back versions. |
| Optional activity and reminders | Record app, window, and activity intervals to help review your day and receive reminders. Both features are off by default. |

### A few ways to start

- **Improve Clax itself:** “Add conversation search to yourself by editing the Clax source, then run tests and verify the build.”
- **Get oriented in a project:** “Explore this project, explain its main modules, and write down how to run it.”
- **Research and act:** “Find current information about this issue, keep the sources, and use the findings to update the current file.”
- **Build working memory:** “Remember: use Chinese for this project, and run tests before committing.”
- **Add a tool:** “Develop and install a plugin for the service I specify. Test it before enabling it.”

Third-party services still require your own credentials or account authorization. Activity recording samples apps, windows, and time; it does not log keystrokes. Selected text is read only when you explicitly save it.

## Installation and first run

Clax is built with Electron, React, and TypeScript, and is currently developed and tested primarily on **macOS**. Windows and Linux have not been tested on real devices. The steps below run it from source.

Requires **Node.js 22.16+**, **pnpm 10+**, and **Xcode Command Line Tools** on macOS. If needed, install the latter with `xcode-select --install`.

```sh
git clone https://github.com/AllenWxh/clax.git
cd clax
pnpm install
pnpm dev
```

1. Click **C** in the menu bar or press **Option / Alt + C** to open the window.
2. Add your OpenRouter inference key in **Settings → Providers**, or reference the local `OPENROUTER_API_KEY` environment variable.
3. Choose a model and working directory at the top of the window, then enter a task.

### Desktop launcher (macOS)

```sh
pnpm desktop:install
```

This creates `~/Applications/Clax.app` and a desktop shortcut, and enables background startup at login. You can then open **Clax.app** directly without starting it from a terminal each time.

Use `pnpm autostart:off` to disable login startup, or `pnpm autostart:on` to enable it again. The launcher depends on the source directory and its dependencies; reinstall it after moving the project.

## Basic usage

| Action | How |
| --- | --- |
| Open / hide | Option / Alt + C toggles the window; Esc hides it. Click C in the menu bar to open it. |
| Send / new line | Enter sends; Shift + Enter inserts a new line. |
| Add instructions | While a task runs, type a message and press Enter or Steer. |
| Pause / resume / stop | Use the controls beside the message input. |
| Balance and usage | Click the balance at the top. Hover over a model's usage bar for input, cache-hit, and output counts. |

Configure web search in **Settings → Tools**, manage memory in **Memory**, manage plugins in **Extensions**, and enable activity recording and reminders in **Activity**.

Chats and memories are stored locally in `~/.clax` by default. Relevant context is sent when using a remote model. Tools use **full access** by default; change this to automatic decisions or approval before actions in **Settings → General**. Clax imposes no fixed quotas on execution steps, command duration, text size, skills, or memory entries; model context windows, system permissions, account authorization, and plugin isolation still apply. Model calls, search, and background memory capture use your own API credits.

Clax is an experimental project. See [validation notes](TESTING.md) for tested behavior and limitations, and [third-party notices](THIRD_PARTY_NOTICES.md) for references and dependencies.

[MIT License](LICENSE)
