# Clax

Clax 是一个本地常驻的实验性桌面 AI Agent，使用 Electron、React 和 TypeScript 开发。支持 OpenRouter 多模型、流式聊天与运行控制、上下文压缩、Markdown 长期记忆，以及可自行开发、测试和安装的工具插件。可选活动记录和主动提醒默认关闭。

当前主要在 macOS 验证，以下命令从源码启动；尚未提供独立安装包。聊天和记忆存储在本机，使用远端模型时会发送当前请求所需的上下文。

要求：Node.js **22.16+**、pnpm **10+**。macOS 活动记录器及窗口模块使用 Swift / Objective-C++ 编译，需要已安装 Xcode Command Line Tools。

```sh
git clone https://github.com/AllenWxh/clax.git
cd clax
pnpm install
pnpm dev
```

首次使用时提供自己的 OpenRouter 调用 Key，可在 Settings → Providers 填写或引用本地环境变量。API 用量由自己的服务账户结算。可将 `.env.example` 复制为 `.env.local` 配置；该文件不会提交到 Git。

macOS 日常打开可双击桌面的 **Clax.app**，或在 Spotlight 搜索 **Clax**。一次性运行 `pnpm desktop:install` 会创建 `~/Applications/Clax.app`、桌面入口，并启用登录后静默启动。进入桌面后菜单栏会出现 C，再用快捷键唤起聊天；Quit 会正常退出，下次登录再启动。无需打开终端或 Codex。

关闭登录自启动：`pnpm autostart:off`；重新开启：`pnpm autostart:on`。启动入口使用当前项目构建和 Electron 依赖；项目目录移动或依赖升级后，在新位置重跑 `pnpm desktop:install`。启动时加载 zsh 的登录/交互环境，导入已 export 的 Key，启动项只保存路径，不保存 Key。日志位于 `~/.clax/logs/`。

程序常驻托盘，按 **Option（⌥）+ C** 唤起/隐藏贴在屏幕可用区域上沿的白色玻璃窗口。左手拇指按 Option、中指按 C，C 对应 Clax。普通外接键盘用 **Alt + C**；若系统把 Alt / Win 对调，用 **Win + C**。设置里还提供双键 **Option + D / V**。旧默认 Option + Space 和 Control + Shift + Space 自动升级，已选其他组合会保留。左键点击菜单栏 **C** 直接打开窗口，右键打开菜单；**Esc** 隐藏，菜单 **Quit** 退出。点击窗口外部自动收成顶部小条并取消置顶，点击小条再展开；任务会继续。快捷键在 Settings → General 修改，注册失败会提示并保留原组合；普通快捷键无需辅助功能权限。

首次启动会导入本地 `OPENROUTER_API_KEY`，从官方目录发现模型，替换旧 DeepSeek 直连配置并保留聊天。顶部模型菜单默认列出常用 Claude、GPT、DeepSeek、Gemini 等，可搜索全部模型或刷新目录；推理强度只展示该模型目录声明支持的档位，模型默认档不强行覆盖接口设置。推理数据仅回传给同一 Provider 下的同一模型，工具调用会保留 OpenRouter 的加密推理块。

界面参考 Codex 的中性白灰与系统无衬线字体，正文 14px。内容贴满原生窗口，不再叠加厚外沿和内层大阴影，保留轻微半透明。

Key 支持直接输入（系统加密保存）、环境变量名或 `env:OPENROUTER_API_KEY`。环境变量从启动进程或当前 workspace 的 `.env` / `.env.local` 读取。普通调用 Key 供所有模型共用；管理 Key 不能聊天，可在余额弹层显式创建一把 Clax 调用 Key（累计上限 $15、不自动重置），加密保存，管理 Key 只保留为余额查询的环境变量引用，不自动创建或充值。也可在 **Settings → Providers** 管理其他接口。没有 Key 时可在 General 开启 Demo Provider；回复为脚本，工具实际执行。

剩余额度直接显示在顶部，点击后是已用模型的圆角横条，按累计输入 + 输出 Token 缩放，悬停查看该模型的输入、缓存命中、输出及接口费用；没有使用的模型不显示。缓存命中属于输入，不重复加到总量。用量逐次写入本机 SQLite，含工具循环、压缩和记忆请求，跨会话、跨重启保留；旧版本无法拆分的统计保留为历史合计。未回传的用量/费用明确标记。余额来自 [OpenRouter credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)，单 Key 限额来自 [key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)；查询权限不足不显示假零余额，接口记账可能延迟。

顶部选择模型和 workspace，直接聊天。数据默认保存在 `~/.clax`，可用 `CLAX_HOME` 指定目录。

工具默认**全权授权**，读写文件、Shell 和插件等可用工具直接执行，无需反复允许。顶部权限菜单或 Settings → General 可切换为**自动判断**、**操作前确认**，设置跨会话、跨重启保留。确认卡也能点击**全权授权并继续**，立即放行等待中的操作。系统账号授权和插件执行边界独立生效。

任务不再因 16 / 48 步而结束，持续执行到完成、真实错误或用户暂停/停止。Shell 默认不限时，显式 `timeout` 单位为毫秒，0 也表示不限时；后台进程可用进程工具停止。工具参数、文件大小、目录数量、搜索扫描量和原始输出不设 Clax 配额；可主动指定行范围、搜索数量和历史分页。模型收到的工具输出副本仍可能按上下文容量压缩，完整原文始终可查。

回复按流式逐段显示。运行中输入补充指令，按 Enter 或 **Steer** 调整方向：文字输出立即中断，已开始的工具到下一处安全边界生效，未执行的旧工具计划会跳过。等待审批时补充指令会取消旧审批。

**OpenRouter 联网搜索**可直接使用现有调用 Key，不需要另配 OpenAI / Anthropic Key。点击窗口上的联网搜索入口，或进入 Settings → Tools，选择 **OpenRouter · 原生搜索优先** 并保存；选择 OpenRouter 模型且启用 `web_search` 后生效。支持的 GPT / Claude 模型使用原生搜索，其他端点可能由 OpenRouter 回退到搜索引擎。模型按问题决定是否搜索，可直接说“联网搜索……”。回复保留来源链接，关闭搜索后原引用仍保留；搜索失败会显示错误，不伪造成功。

接入采用官方 [Web Search Server Tool](https://openrouter.ai/docs/guides/features/server-tools/web-search)，与本地文件、Shell、插件工具共存，不使用每次都强制搜索的旧 `:online` / `web` 插件。该接口目前为 Beta，支持范围以 OpenRouter 为准。搜索及处理结果的费用从原 OpenRouter 余额扣除，按模型记录接口费用、输入/缓存/输出；只有接口回传了搜索次数才累计，不把缺失值补成零。后台压缩和记忆整理不启用搜索。现有 Tavily / SearXNG 仍可在同一设置中选择。

Clax 现在可自行开发**持久插件**。例如对它说“给自己开发并安装一个联网搜索工具”或“开发 Gmail 只读插件，接入搜索和读取邮件”。运行循环会发现能力缺口，读取插件 SDK，编写 `manifest + JavaScript + tests`，先测试，再安装；新工具在同一轮的下一步即可调用，无需重启。原有能力已能完成任务时会先复用，Skills 仍是操作说明，不替代可执行插件。

**Settings → Extensions** 展示插件草稿、测试、已安装版本、网络目的地、账号连接、启停和回退。代码、离线 HTTP fixture 测试及不可变版本保存在 `~/.clax/extensions/`，实际安装会重新跑测试；失败草稿不会覆盖正常版本。测试只能证明已有用例，真实服务仍需验证。遇到工具错误时，Clax 可以根据错误修改草稿，再测试安装；这种改进由当前任务驱动，不会在空闲时自行改写核心程序。

插件通过独立 Worker 中的 [QuickJS](https://github.com/justjake/quickjs-emscripten) 执行，客体代码没有 Node、文件、Shell 或环境变量入口，只能调用宿主的受控 HTTPS 接口。不设 Clax 执行时长、请求数量、源码/输出大小或自定义内存配额；用户停止任务或停用插件会终止 Worker。只允许清单中的域名和方法，拒绝重定向、本地网段和额外端口。macOS TUN 代理的 198.18/15 虚拟 DNS 仅在实际路由为 utun 时兼容，仍保留 HTTPS 证书校验。此边界针对插件执行，不限制用户另外授权的工作区文件和 Shell 工具。插件管理也遵循 Ask / Auto / Full 权限模式。

插件联网搜索示例使用 [Tavily API](https://docs.tavily.com/documentation/api-reference/endpoint/search)，需要你自己的搜索服务 Key；开发和安装不等于自动获得第三方服务账户。Key 在 Extensions 中填写，使用系统 safeStorage 保存并由宿主注入请求，不放进插件源码。Gmail 示例采用 [Google 桌面 OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)：提供 Google Cloud 的 Desktop OAuth Client ID（以及客户端要求的 Secret）、启用 Gmail API、将个人账号加入测试用户，然后在系统浏览器点击授权。回调使用随机本机端口、state 和 PKCE，令牌可刷新，清单或连接目的地变化后须重新连接。第一版使用 [gmail.readonly](https://developers.google.com/workspace/gmail/api/auth/scopes)，不发送或删除邮件；断开会清除本机保存的连接。Clax 自己持有这份授权，不使用 Codex 的 Gmail 连接器。

真实 DeepSeek 已在独立数据目录中自行编写、测试、安装并调用一个新的 HTTP 插件，实际读取 `example.com` 网页标题。搜索示例和 Gmail 示例的离线测试、OAuth 回调协议测试及桌面管理检查另见 `TESTING.md`；没有真实 Tavily Key 或 Google OAuth 客户端时，不把示例测试称为服务已连通。完整浏览器的点击、登录和页面交互，以及 MCP 插件适配，尚未加入本版 HTTP 插件 SDK。

**暂停**会取消当前请求和运行中的命令，保留已有输出与任务记录；**继续**用保留的上下文重新请求模型，接着处理。暂停状态在重启后保留。**Stop**结束任务。

上下文会按估算 token 管理，中文、工具参数、系统提示和工具定义都会计入预算，并为回复预留空间。接近预算时，先保存需要记住的信息，再分块总结旧对话，保留近期用户消息和完整工具调用/结果组。摘要保存目标、约束、决定、关键标识、已验证结果和待办；结构不合格会重试一次，失败则明确使用带来源的原文片段回退。接口报告上下文过长时，会按模型逐次收紧预算并压缩重试，已经执行的工具不会再次执行。完整聊天原文一直保存在 `sessions.db`，大工具输出只缩短发送给模型的副本，可通过 `session_history` 找回。

上下文默认选择**模型最大容量**，不再另设 256k 上限；按模型容量扣除安全余量和原生输出预留，未知容量按 32,768 处理。Settings → General 仍可主动选较小预算，显示有效输入预算及 82% 压缩触发量。磁盘字段 `maxContextChars: 0` 表示自动，正值兼容旧版 3 倍 token 数。单轮工具循环也可压缩已完成步骤，完整最新指令和最后一组工具结果保留；不会因为同一条指令太多步骤而停止。扩大预算不自动还原已有摘要，完整原文始终保留在本机。模型接口、账户额度与操作系统的实际限制独立生效。

长期记忆默认开启，数据仍全部位于 `~/.clax`：

- `memory/USER.md`、`PREFERENCES.md`、`MEMORY.md`：你手动维护的全局背景和偏好，兼容原有文件；项目专属事实用默认 project 范围的 `remember` 保存。
- `memory/entries/*.md`：自动提取或主动保存的稳定偏好、事实和项目决定，附带时间、范围及来源。相同稳定 key 的新内容替代旧内容；旧版本保留在不参与检索的 `archive/`。
- `memory/daily/YYYY-MM-DD-*.md`：按日期保存 Clax 中的用户请求、回复片段和工具结果，标明状态及原始消息 ID。此处不采集其他应用或桌面活动。
- `memory-index.db`：可从 Markdown 重建的 SQLite FTS5 索引。关键词、中文词片段、时间和项目范围参与排序。没有接入向量 embedding；无需额外的记忆服务账户。

每次聊天带入少量用户背景和近期通用偏好，再按问题检索相关内容。`memory_search` 查相关条目，`memory_get` 读来源行，`session_history` 查完整原始聊天，`remember` 主动保存，`memory_forget` 移除过时条目。项目记忆按工作目录隔开，通用偏好跨会话使用。

对话完成后，自动整理在后台运行：每日记录直接保存，模型只从用户原话中提取稳定信息，要求引用原始消息和原文证据；网页、工具输出和模型自己的断言不会直接变成个人偏好。启动时会补记当前已完成会话里尚未整理的内容，检查点避免反复提取；不导入其他应用的聊天。提取失败时每日记录仍然保留。新消息会取消未完成的整理，暂停/Stop/退出也能中止相关请求。已配置的 Key 和常见凭据格式在记录与检索时过滤；原始聊天记录仍按原有方式本地保存。

**Settings → Memory** 可开关记忆/自动整理、搜索、查看来源、忘记条目及编辑原有 Markdown。自动提取和压缩使用当前模型，额外请求计入 Usage；Token 预算是保守估算，费用数字以接口返回为准。自动提取需要模型判断，仍可能记错，可在设置中纠正或忘记。索引不能取代原始来源。

这次实现参考 [OpenClaw 的压缩流程](https://github.com/openclaw/openclaw/blob/467fc82c4fd96e6dd55b3d0a6c1559dcf7d0b291/docs/concepts/compaction.md)、[分层 Markdown 记忆](https://github.com/openclaw/openclaw/blob/467fc82c4fd96e6dd55b3d0a6c1559dcf7d0b291/docs/concepts/memory.md)，以及 [Open Dot 的 remember / forget](https://github.com/composio-community/open-dot/blob/f838e17cf5c3a88ade5ceea54680a8145d048c1d/src/server/agent/tools.ts)，在 Clax 中独立实现。自动技能学习尚未接入；活动提醒可在 Settings → Activity 开启，默认关闭。

**Settings → Activity** 管理其他应用的电脑活动，默认暂停。开启后约每 3 秒采样前台应用、窗口标题、距离上次操作的时间，连续在同一窗口时合并成时段。超过 60 秒无操作、锁屏或休眠时暂停计时；隐藏 Clax 不会停止记录。菜单栏 C 旁的黑点和窗口里的状态提示表示活动记录已开启，右键 C 可暂停、查看当天记录。

活动采集由 `native/activity.swift` 调用 macOS 原生接口完成，不请求模型，不读取按键内容、鼠标轨迹、剪贴板或整页正文。只有你先在其他应用中选中文字，再点击 **右键 C → 记录选中文字**（或唤出 Clax 后在 Activity 点击同名按钮）时，才尝试读取该选区。窗口标题和选文字需要 [macOS 辅助功能授权](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesistrustedaccessibilityclientprompt-macos)，可点击 **打开权限设置**；开发运行时系统可能显示 Electron 或 clax-activity。应用不提供辅助功能选区时会提示失败，不会偷偷切换到剪贴板或截图读取。

默认排除密码管理器和系统设置，发现焦点为密码框或标题包含隐私浏览标记时跳过；可按应用名或 bundle ID 添加排除项。这些识别不能覆盖所有软件的敏感窗口，敏感应用应加入排除列表。已配置 Key 和常见凭据格式也会过滤。

活动数据单独保存在本机 `activity.db`，跨聊天及工作目录查看，以观测记录作为证据；不会自动当成偏好、技能或“已完成任务”。**记忆检索使用活动** 开启且总记忆开启时，询问“今天做了什么”等问题会带入相关活动；模型也可用 `activity_search` 按日期、关键词分页查找。关闭此项会阻止后续请求读取活动，但本机仍能查看。采集期间不会周期性上传；聊天时调用远端模型会发送所检索的内容。

Activity 可按天查看、中文搜索和删除，默认保留 30 天，可改为 7/90/365 天。删除会清理活动数据库及其旧页面，不保留恢复副本；已经发进聊天的内容仍属于聊天记录，需要单独管理。采样时长为估算，短于采样间隔的切换可能遗漏，不能从停留在某个窗口直接断定完成了工作。

从旧版升级时，会自动迁移原数据目录，保留会话、Memory、Skills 和 Provider 配置。

验证：`pnpm test`、`pnpm build`、`pnpm test:desktop`、`pnpm test:activity`。活动测试使用独立数据和受控验证窗口，不请求实际模型。当前仅在 macOS 实测，活动采集仅支持 macOS；Windows/Linux 其他功能需要本机验证。Codex app-server 与更深的 OpenClaw 集成尚未接入。

源码以 [MIT 许可证](LICENSE) 发布。参考项目和依赖的说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，测试方式与历史验证记录见 [TESTING.md](TESTING.md)。
