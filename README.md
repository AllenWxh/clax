# Clax

[中文](#中文) · [English](#english)

## 中文

Clax 是一个常驻桌面的实验性 AI Agent，支持多模型聊天、流式输出、上下文压缩、长期记忆和工具插件。当前主要在 macOS 上使用和验证。

### 安装

需要 Node.js **22.16+**、pnpm **10+**；macOS 还需要 Xcode Command Line Tools。

```sh
git clone https://github.com/AllenWxh/clax.git
cd clax
pnpm install
pnpm dev
```

### 基础操作

- **配置模型**：在 Settings → Providers 填入自己的 OpenRouter 调用 Key，或引用本地 `OPENROUTER_API_KEY`；在窗口顶部选择模型。
- **唤出窗口**：按 **Option / Alt + C**，按 **Esc** 隐藏，也可以点击菜单栏的 **C**。
- **聊天控制**：Enter 发送，Shift + Enter 换行；运行中可用 **Steer** 补充指令，或暂停、继续、Stop。
- **日常启动**：运行一次 `pnpm desktop:install`，之后双击 Clax.app 即可，并默认登录自启动；`pnpm autostart:off` 关闭自启动。

聊天和记忆保存在本机，使用远端模型时会发送所需上下文。工具默认全权授权，可在设置中调整。

## English

Clax is an experimental desktop AI agent that stays in your menu bar. It supports multiple models, streaming chat, context compaction, long-term memory, and tool plugins. It is currently developed and tested primarily on macOS.

### Installation

Requires Node.js **22.16+**, pnpm **10+**, and Xcode Command Line Tools on macOS.

```sh
git clone https://github.com/AllenWxh/clax.git
cd clax
pnpm install
pnpm dev
```

### Basic usage

- **Configure models**: Add your OpenRouter inference key in Settings → Providers, or reference your local `OPENROUTER_API_KEY`. Select a model at the top of the window.
- **Open the window**: Press **Option / Alt + C**, or click **C** in the menu bar. Press **Esc** to hide it.
- **Chat controls**: Enter sends; Shift + Enter adds a new line. Use **Steer** to add instructions during a task, or pause, resume, and Stop.
- **Desktop launch**: Run `pnpm desktop:install` once, then open Clax.app directly. This also enables login startup; `pnpm autostart:off` disables it.

Chats and memories are stored locally; relevant context is sent when using a remote model. Tools use full access by default, which you can change in settings.

[MIT License](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
