# 验证记录

复验入口：`pnpm test`、`pnpm build`，以及 `package.json` 中各 `test:*` 桌面脚本。以下为历史验证记录，`test-results/` 中的本机报告、截图与数据不随源码发布；真实模型 smoke 脚本会消耗调用者的 API 额度。

2026-10-21 移除余下内容配额与技能自我改写：

- 移除摘要 2,200 tokens、背景 2,400 tokens、技能全文、记忆文件大小/目录层数/查询候选/提取条数与证据、活动条数/选区和引用数量的固定截断。摘要及请求仅按实际模型窗口分配；原文保留。项目指令和当前技能优先于历史检索，背景按完整来源装载；放不下时提示来源读取工具，避免半段 JSON 或技能进入请求。
- 系统提示与插件 SDK 允许按任务需要修改自身核心源码；新增 `skill_manage` 读写与启停技能，下一步模型请求即可使用新技能。项目根 `AGENTS.md` 加入上下文。取消插件名称的独立长度配额，实际文件系统和模型协议约束仍适用。
- 取消账号/目录查询、后台提醒、选区、OAuth 等 Clax 自定执行期限；停止、停用或退出负责取消。活动默认不限期保留，提醒间隔和保留天数接受自选值。创建 OpenRouter Key 的累计额度可填写或留空；脚本也支持可选 `CLAX_OPENROUTER_KEY_LIMIT`。没有创建真实 Key、改动已有 Key 的服务端额度或追加付费模型验收。
- `pnpm test`：91 项通过；覆盖超旧配额的完整摘要、技能、记忆文件/候选/提取证据、引用、活动，以及真实窗口不足时的完整块保留、插件长名称、动态 Anthropic 输出额度和后台取消。`pnpm build` 与 `git diff --check` 通过。
- Electron 桌面回归 51 项通过：主界面 26、插件 6、OpenRouter 8、活动 11。主界面新增实际工具写入长技能后立即注入下一步请求；活动实机验证前台窗口、选文与密码框排除。模型回复和搜索使用明确标注的本地 HTTP fixture，不等同于付费模型验证。
- 正式 Clax 经原应用入口重启，只有一个常驻实例；全权授权和跟随模型容量保持生效。220 条原消息、摘要、所选模型、配置、Provider、加密凭据和 77 条用量记录核对保留。数据已做 SQLite 在线及文件备份；报告与备份路径见 `test-results/open-harness-restart-validation.json`。

2026-10-21 取消人为运行配额：

- 删除 16 / 48 步硬结束及强制收尾提示。任务持续到模型完成、真实错误或用户暂停/停止；Steer、取消和完整工具调用/结果配对继续有效。Shell 默认 timeout=0，显式超时仍可用，并避免大于 Node 定时器范围的超时被误解成 1 ms。
- 取消工具参数、原文输出、命令长度、文件读写/编辑大小、目录数量、文件搜索扫描量、HTTP 文本/流帧及历史工具的额外截断。能放进模型窗口的结果完整发送；只有容量不足才压缩发送副本，原文保存。移除搜索服务端工具的 Clax 次数/结果配额，服务商自身规则独立生效。
- 插件不设执行时间、HTTP 调用数、输出/源码/包大小、schema 规模或自定义 Worker/QuickJS 内存配额；停止任务或停用仍终止 Worker。隔离、HTTPS 域名/方法清单、账号授权及凭据过滤保留。原生名称、DNS 等协议约束仍需满足。
- 上下文默认跟随模型容量，显式旧预算仍可选。单轮内部也可压缩已完成工具组，完整最新指令与最后一组结果保留；连续实际溢出逐次缩小有效窗口，不重放已执行副作用。输出按每次请求剩余空间分配。实际选中模型目录显示窗口 1,048,576、最大输出 943,718，修复全额预留输出导致输入只剩 256 的边界，新有效输入预算为 681,574。
- `pnpm test`：79 项通过；覆盖 72 步完成、60 步后取消、超旧大小限制的文件/命令/输出/流帧、25 次插件 HTTP 请求、大源码及输出、单轮压缩保留、连续溢出恢复，以及上述大原生输出的动态分配。`pnpm build`、TypeScript 与 `git diff --check` 通过。
- `scripts/desktop-test.ts` 的 25 项 Electron 检查通过，实际 HTTP fixture 在同一条指令下完成 60 次工具调用；原暂停/Steer/停止/审批/记忆及默认最大容量与重启保留继续通过。`scripts/extensions-desktop-test.ts` 的 6 项检查通过，包含已构建 Worker 的开发/测试/安装/调用和停用/回退；这些不是付费模型调用。
- 正式 Clax 已从原入口重启，全权授权、模型容量模式已保存。220 条原消息、已有摘要、所选模型、Provider、加密凭据及其他设置逐项保留；正式用量表行数未变化。备份与最终核对见 `test-results/unlimited-restart-validation.json`。
- 另在隔离数据/工作目录复用现有加密凭据，真实请求当前 `deepseek/deepseek-v4.1-flash`，返回 `CLAX_RUNTIME_OK`，有效输入预算 681,574；接口回传输入 259、输出 8、费用 $0.00008471。结果在 `test-results/unlimited-live-validation.json`。该验证没有写入正式聊天/本机用量，账户余额包含此真实费用。

2026-10-16 OpenRouter 原生优先联网搜索：

- 接入官方 `openrouter:web_search` server tool，使用现有加密调用 Key、native 优先，与本地函数工具共存。没有增加 OpenAI / Anthropic Key 或创建新 Key；保留 Tavily / SearXNG。模型按需搜索，禁用后不发送；后台记忆与压缩请求不附带搜索。
- `pnpm test`：64 项通过；新增 4 项覆盖引用 URL/位置校验与合并、0/0 无位置引用不插到正文开头、本地工具与原生搜索续接、引用及计数持久化、后台提取不联网、失败/禁用/非 OpenRouter 不伪造搜索，以及旧用量表增量迁移。搜索次数列为 nullable，未回传不补成“实际搜索 0 次”。构建和 TypeScript 检查通过。
- `scripts/openrouter-desktop-test.ts`：8 项检查通过，包含联网入口、保存开关、实际 HTTP 请求参数、可点击行内引用和来源条、重启保留，以及关闭后移除服务端工具。这里使用标明的本地 HTTP fixture；截图在 `test-results/openrouter-native-search.png`。
- `scripts/native-search-smoke.ts` 在独立数据/工作目录，复用系统加密凭据，真实请求 `anthropic/claude-sonnet-5.5` 与 `openai/gpt-6.1-sol`，均返回 Python 官方 TaskGroup 文档的结构化引用。接口分别回传输入 15,136 / 9,573、输出 180 / 114、费用 $0.042072 / $0.033071，合计 $0.075143；两次均未回传独立搜索次数，记录为未知，不声称各只执行了一次搜索。验证数据不合并进正式聊天或本机用量，账号余额包含这些真实费用。结果见 `test-results/native-search-live-validation.json`；此脚本会产生真实用量。
- 原有桌面回归 23 项通过。本次设备锁屏，失焦改用明确标注的 collapse/expand IPC 检查，原生热键未执行；不把它称为新的实体键盘验证，原热键代码未改。
- 正式 Clax 已经原入口重启，启用 OpenRouter 联网搜索。101 条消息、既有摘要、当前 Opus 选择、256k 预算、其他设置、Provider 和加密凭据均保留；原有 20 条用量记录所有旧字段逐项一致，仅增加搜索次数列。结果及备份路径见 `test-results/native-search-restart-validation.json`。

2026-10-16 上下文预算扩至 256k：

- 默认输入预算为 256,000 个估算 tokens，约到 209,920 时压缩；General 提供按 token 标注的 16k / 32k / 64k / 128k / 256k，显示按当前模型容量限制后的预算和触发量。界面与运行时共享限制计算，磁盘保留旧字符单位兼容，显式旧设置不被覆盖。
- `pnpm test`：60 项通过。新增覆盖约 180k 历史不压缩、超过 82% 后压缩且保留原文和近期轮次，以及小容量/未知模型的回复预留和预算限制。大连续文本同时走实际脱敏逻辑，修复路径提取与凭据字段匹配在长文本上重复回溯的问题；已有凭据过滤检查继续通过。
- 构建、最终 `pnpm typecheck` 和 24 项 Electron 桌面检查通过，新增 256k 设置经 IPC 保存、容量提示及重启保留。桌面测试工作目录现也隔离到测试数据内，避免重复写样例文件产生冲突。测试用量来自本地协议 fixture；没有付费模型验证。
- 等正式任务完成后，经原应用入口重启。有效输入预算为 256,000，101 条原消息、已有摘要、所选模型、Provider、加密凭据和其他设置逐项核对保留；用量表行数未变化。结果与备份路径见 `test-results/context-256k-restart-validation.json`。Memory 面板的旧预算标为上次请求，后续请求按新预算更新；不自动撤销已有摘要。

2026-10-16 工具全权授权更新：

- 默认权限改为全权授权，顶部与 General 可切回自动判断或操作前确认；显式选择不被升级覆盖。确认卡新增“全权授权并继续”，会放行所有等待中的会话，后续工具立即采用新模式，重启后保留。
- `pnpm test`：58 项通过；新增 3 项验证默认值与显式选择跨重启保留、多会话待审批及后续工具一并继续、异步路径检查捕获旧权限后仍采用新的全权授权。原有拒绝、Steer、暂停及根目录/磁盘破坏拦截检查继续通过。
- `pnpm build` 通过；`scripts/desktop-test.ts` 的 23 项真实 Electron 检查通过，新增实际点击全权授权后继续 Shell、写文件、不再出现审批卡，以及重启保留。模型响应来自标明的本地 HTTP fixture，不产生真实模型用量。
- 未新增读取模型型号的工具或把指定型号写入身份提示。现有回复标题显示请求所选模型，不当成实际后端的独立证明。余额刷新逻辑保持为每次请求完成后约 1.2 秒、打开面板时、窗口可见时每 60 秒，以及手动刷新；官方记账仍可能延迟。
- 正式 Clax 已通过现有应用入口重启，权限持久化为 `full`。91 条原消息逐条比对保留，所选模型、Provider、加密凭据及其他设置保持一致；备份与结果见 `test-results/permissions-restart-validation.json`。没有为本次验证请求真实模型。

2026-10-16 OpenRouter、额度与界面更新：

- 默认从本地 `OPENROUTER_API_KEY` 接入 OpenRouter，读取模型目录和各模型支持的推理档位。移除原 DeepSeek 直连配置，保留聊天和历史模型标记。实测发现本地是管理 Key、推理返回 401；经用户明确授权，创建了一把名为 Clax 的普通调用 Key，累计上限 $15、不自动重置，使用 Electron safeStorage 保存。管理 Key 仍仅保留环境变量引用供额度查询，启动不自动创建 Key。
- 当时目录中有 388 个适合当前聊天适配器的模型（排除 batch 与仅图片输出）。默认展示常用模型，也可搜索全部、刷新目录；推理档位按 `reasoning.supported_efforts` 和 mandatory 元数据约束，保存到会话并跨重启保留。
- 顶部直接显示官方余额，一次点击展示已用模型的圆角比例条；按输入 + 输出缩放，不重复加缓存命中。悬停显示输入/缓存/输出及接口费用，未使用模型不显示。SQLite 逐次保存用量，包含工具循环、压缩及记忆；升级前无法拆分的统计仅迁移一次，保留为历史合计。官方余额记账可能延迟，403 等失败不伪装为零余额。
- `pnpm test`：55 项通过，新增 6 项覆盖模型能力、额度权限降级、推理/加密块的工具续接、切换模型时不发送其他模型的推理块、用量跨重启/旧数据迁移，以及授权创建 $15 Key 和管理/调用凭据分离。
- `pnpm test:openrouter`：6 项真实 Electron 界面检查通过，使用标明的本地 HTTP fixture；验证顶部余额、常用/全部模型、档位、比例条长短与悬停、重启保留和受限额度查询。截图在 `test-results/openrouter-usage.png`，不是个人账号截图。
- `scripts/openrouter-smoke.ts` 使用已安装的加密调用 Key、独立 CLAX_HOME 和受控目录，真实调用 `anthropic/claude-sonnet-5.5`，low 档完成目录工具及回复。2 次请求返回输入 1607、输出 65、缓存命中 0、实际费用 $0.003864。该次没有返回推理块；加密推理块往返由独立协议测试验证，不把 fixture 冒充实机推理。结果在 `test-results/openrouter-live-validation.json`。此脚本会产生真实 API 用量。
- 召出窗口移除 8px 内嵌外沿和 CSS 大阴影，采用中性白灰、系统无衬线字体及 14px 正文；保留原生阴影与轻微半透明。已查看构建后的界面截图。`pnpm build` 和最新原有 22 项桌面回归通过，包括快捷键、流式、控制、审批和记忆；快捷键隐藏也延迟至修饰键释放后，避免窗口重新弹出。
- 正式 Clax 已通过原桌面入口重新打开，只有一个常驻实例。原 85 条消息内容逐条比较完全不变，设置文件哈希一致；Provider 已切为 OpenRouter，调用 Key 为加密保存，管理 Key 只有变量名引用。结果在 `test-results/openrouter-restart-validation.json`。

2026-10-16 桌面唤出修复：

- 实际复现：进入 macOS“显示桌面”后，Clax 原生窗口从 `(510, 30, 840, 700)` 移到 `(1908, -317, 840, 700)`，但 Electron 的位置、可见与聚焦状态未反映该变换，导致快捷键误隐藏或只在屏幕外展开。
- 新增小型 Node-API 窗口模块设置 AppKit Stationary，清除互斥的 Managed / Transient；展开与缩回改变窗口层级后重新应用。只设置 Electron 的跨桌面或 Mission Control 隐藏标记不足以修复，最终不使用该隐藏标记。
- `pnpm test:shortcut` 使用独立 `CLAX_HOME`、独立 AppKit 窗口、Finder 和系统“显示桌面”操作，验证 6 项：跨应用、Finder、显示桌面下实际窗口位置、隐藏后唤出、失焦缩回取消置顶、缩回后恢复。检查同时比较 CGWindowList 实际坐标与 Electron 坐标，验证原生按键实际进入输入框及再次隐藏，不能只靠 `isVisible/isFocused` 判断成功。结果在 `test-results/shortcut-desktop-validation.json`；使用 CGEvent 模拟，未声称按过实体键盘，也未覆盖独立 Space 或全屏。
- `pnpm build`、49 项测试及原有 22 项桌面回归通过。正式实例已从现有 Clax.app 入口重新启动，57 条原消息全部保留，设置、Provider 和加密凭据文件哈希一致；结果在 `test-results/shortcut-desktop-restart.json`。快捷键保持 Option + C。

2026-10-16 自我扩展 / 插件执行验证：

- 新增 `extension_manage` 和每步刷新的工具清单：可以读取 SDK/示例及已有源码，开发草稿，运行测试，安装、停用或回退。插件版本按内容哈希保存，安装重新跑测试；失败草稿、过期工具定义、被篡改的版本及测试期间的状态变化不能覆盖已工作的版本。
- `pnpm test`：49 项通过。新增 7 项涵盖生命周期/重启/回退、失败及篡改、联网搜索/Gmail fixture、权限与 Node 隔离、超时与停用取消、Google OAuth state/PKCE/刷新/取消，以及同一轮模型请求开发安装后立即使用新工具。验证也覆盖输入 schema 限制、认证头控制字符和连接目的地变化后的凭据失效。
- `pnpm build`：TypeScript、主进程/独立 Worker、preload、React 和 Swift 构建通过。新增依赖为 QuickJS、Ajv、Undici 7 和 ipaddr.js，保持项目声明的 Node 最低版本兼容。
- 真实 `deepseek-flash` 在独立数据目录中生成 `public-check` 插件源码和测试，完成 stage/test/install，并在同一轮调用 `ext_public_check_probe` 真实访问 example.com，返回网页标题。结果在 `test-results/live-extensions-validation.json`；没有向正式会话写入测试插件或测试消息。可用 `pnpm exec tsx scripts/extensions-smoke.ts` 复验，会产生模型 API 用量。
- `pnpm test:extensions` 的桌面流程验证 Settings → Extensions、实际 HTTP 模型协议、Electron 中的 QuickJS Worker、失败升级保留原版、启停/回退、Gmail 缺少客户端配置时的真实提示，以及重启持久化。6 项检查及截图在 `test-results/extensions-desktop-validation.json`、`test-results/extensions.png`。模型回复使用明确标注的本地协议 fixture。
- 原有桌面回归 22 项通过。原生热键检查发现按键释放前激活应用会失去焦点，改为 macOS 热键延迟 150ms 展开，并用独立 AppKit 窗口验证跨应用唤出、聚焦和隐藏，未使用手动聚焦补救来冒充热键成功。
- 网络检查在本机发现 198.18/15 Fake-IP 由 utun 转发，加入仅限这种实际路由的兼容；普通私网和回环仍被拒绝，HTTPS 校验保持开启。真实 HTTP 请求成功，搜索/Gmail 示例使用离线响应测试。没有真实 Tavily Key 或 Google OAuth 客户端授权，因此不声称实际搜索服务或个人邮箱已连通，也未发送邮件。
- 正式 Clax 已通过现有桌面入口重新启动，仍只有一个常驻实例，登录启动项保持注册。原 42 条消息逐条比对保留，设置、Provider 和加密 Key 文件哈希一致；生产插件目录为空，未复制验证插件或伪造个人账号连接。结果在 `test-results/extensions-restart-validation.json`。

2026-10-16 macOS 日常启动与登录自启动：

- 新增 `pnpm desktop:install`：构建项目，编译本机 Swift 启动器，安装 `~/Applications/Clax.app` 及桌面入口。白底黑色 C 图标、应用签名和 plist 均已验证。
- 登录项位于 `~/Library/LaunchAgents/com.clax.agent.plist`，通过 LaunchServices 静默打开启动器，`RunAtLoad` 在登录时执行一次，没有 `KeepAlive`。`pnpm autostart:off` 关闭，`pnpm autostart:on` 恢复；关闭登录项不会结束正在运行的 Clax。
- 在当前 GUI 会话实际触发启动项，确认一个正式 Clax 进程运行，聊天窗口没有弹出。实际打开桌面 Clax.app 后，原进程显示窗口并取得焦点，没有第二个常驻实例。
- `pnpm desktop:install`（包括 TypeScript、Electron 和 Swift 编译）通过，42 项测试通过，启动集成 6 项检查通过。原 42 条消息逐条比对保留，设置、Provider 和 Key 文件哈希一致。结果在 `test-results/login-startup-validation.json`。
- 没有为验证而重启电脑或注销账号；已加载并触发同一个登录启动项。启动入口依赖当前项目目录及 Electron 依赖，移动项目或升级依赖后需重跑安装命令。启动时读取 zsh 导出的环境变量，启动器配置和登录项中不保存 Key。

2026-10-08，在 macOS arm64、Node 22.22.0、pnpm 10.26.2 上实际运行。

- `pnpm install --frozen-lockfile`：成功，Electron 安装脚本正常运行。
- `pnpm build`：TypeScript 和 Electron / React 构建通过。
- `pnpm test`：42 项通过，包含原有工具/权限/流式/运行控制回归，以及中文尾部检索、文件修改与删除同步、索引删除/损坏恢复、项目隔离、凭据过滤、记忆来源、更正/忘记、检查点与启动防重放、分块压缩、工具配对、取消/失败回退、模型容量和溢出重试不重复执行工具。新增 8 项活动记录测试覆盖默认不开启、活跃时段与闲置边界、排除、选文过滤与重启、同时间分页、实际数据库删除、保留时间、模型访问开关、长背景下的活动上下文、暂停/锁屏与删除后迟到响应。
- `pnpm test:desktop`：21 项通过。实际启动 Electron，验证原有窗口、快捷键、工具、Provider、流式输出、Steer、暂停/继续、Stop、审批和重启行为；新增自动提取/每日记录、Memory 开关/中文搜索/来源查看、新会话注入偏好、重启恢复和“忘记”按钮。测试使用独立的数据及 Chromium 目录。
- 实际界面：切换到访达窗口后自动收成顶部白色小条，点击小条恢复聊天；正在运行的任务继续。收起/展开后未保存的 Provider 表单输入仍在，展开不会误点模型菜单。
- 实际 DeepSeek：自动引用 `DEEPSEEK_API_KEY`，发现两款模型；调用 `read_file`、`list_directory`、`shell`。Agent 执行 `npm test`，14 项通过、退出码 0；同一会话从 Flash 切换到 Pro 后仍保留上下文。Usage 使用接口返回的真实数据。

桌面测试结果和截图保存在 `test-results/`，实际模型验证记录为 `test-results/live-deepseek-validation.json`，不包含 API Key 值。

项目已更名为 Clax。旧版加密 Key 在改名后仍能读取；会话 runtime 标识更新时保留原时间戳。兼容检查记录为 `test-results/rename-validation.json`。

全局默认快捷键现为 Option / Alt + C（双键），设置还提供 Option + D / V。旧的 Option + Space 和 Control + Shift + Space 自动迁移到新默认，独立选择的其他组合保留。使用 Electron 的系统注册接口；已删除 Home + End 的原生按键监听和相关依赖。实际制造注册冲突后，错误可见、旧快捷键和已保存的设置均保留。此前 Control + Shift + Space 已由用户通过外接实体键盘确认能唤出窗口；新的 Option + C 原生事件验证见下方，尚未由用户在实体键盘上确认。菜单栏 C 左键直接打开窗口、右键打开菜单的逻辑已完成回归测试。

运行控制使用本地 HTTP 流测试：请求未结束时 UI 文字持续增长；Steer 取消未结束的模型请求，并将新指令发送到下一次请求，工具已开始时则在安全边界调整。暂停停止模型请求或运行中的工具，补齐工具调用结果并保留部分输出；继续使用保留的上下文。等待审批时 Steer 取消旧审批且不执行旧计划。重启后暂停任务可以继续。上述新增控制未单独调用真实 DeepSeek 做验证。

长期记忆与上下文压缩已另外使用真实 `deepseek-flash` 验证，测试数据位于独立目录，没有写入个人偏好或覆盖生产聊天。自动提取保留用户原话证据，新会话在没有原始聊天的情况下回答“中文”；关闭存储后重新打开仍检索到同一条记忆。实际压缩保存结构化摘要、关键路径和原文，最新用户消息完整保留，压缩后的上下文估算小于预算。结果在 `test-results/live-memory-validation.json`；可以手动运行 `pnpm exec tsx scripts/memory-smoke.ts` 复验，会使用本地 DeepSeek Key 并产生 API 用量。

第一次真实模型压缩因输出额度过小而回退，修正为单独预留推理/输出额度后再次通过；保存摘要的预算与生成请求的额度分开。摘要按完整语句缩短，避免截断否定词。桌面搜索管理通过实际按钮验证，重启后等待结果可见再操作忘记。

正式 Clax 已用最新构建重启。先对空闲会话做 SQLite 在线备份，再逐条按消息 ID 比对：原来的 18 条消息均保留，Key、Provider、手动 Memory 和 Skills 文件哈希一致。启动补记和后续新消息已经生成可检索的每日记录；结果在 `test-results/memory-restart-validation.json`。自动学习内容写在独立 entries/daily 文件中，不覆盖原有手动背景文件。

Windows/Linux 尚未实机验证。Anthropic、Gemini、Ollama 已完成协议解析测试，未使用对应真实模型账户测试。Codex app-server、深入 OpenClaw 集成、Browser/Computer Use 为后续范围。

2026-10-08 活动记录实现验证：

- `pnpm build`：TypeScript、Electron/React 和原生 Swift 采集器编译通过；没有新增 npm 依赖。
- `pnpm test:activity`：9 项检查通过。使用真正的原生采集器确认锁屏时没有应用/窗口/选文数据，显式选文请求返回锁屏提示；验证 Electron 状态、暂停、中文活动搜索、时长与选文展示、活动经本地 HTTP 协议进入当天问题的上下文、模型访问开关、重启恢复和按天删除。UI/HTTP 验证使用写入独立测试数据库的合成活动；没有请求真实模型或把测试活动写入生产数据。结果在 `test-results/activity-validation.json`，截图在 `test-results/activity.png`。
- 这次设备实际锁屏，前台为系统 loginwindow。真实前台窗口、选中文字及密码框排除的成功路径仍需解锁后重跑 `pnpm test:activity`，脚本已包含这些验证，报告明确记录限制。辅助功能权限没有自动修改。
- 原有桌面回归 21 项通过。这次锁屏不能产生真实 OS 失焦事件，该项改为明确标注的 collapse/expand IPC 与原生窗口边界检查；真实失焦路径此前已验证，本次仍需解锁复验。结果中的 `limitations` 保留此区别，没有把锁屏下的 IPC 检查称为物理失焦验证。

生产升级先备份空闲的 SQLite 会话及原有配置，然后重启。活动记录默认暂停，由用户在 Settings → Activity 或托盘开关启用；生产聊天与 Key 的保留检查另见 `test-results/activity-restart-validation.json`。

2026-10-09 双键快捷键更换验证：

- 默认改为 **Option + C**，设置新增 **Option + D / V** 备选。旧默认自动升级，独立选择的替代组合及其他设置保留。按当前 ikbc 的修饰键映射，实体 **Win + C** 对应逻辑 Option + C；Mac 内置键盘使用 Option + C。
- 核对本机系统搜索、输入法组合，以及安装的 Codex 的 Show Mini 默认 Option + Space；逐个实测候选注册。注册可用只是筛选，不能据此保证所有应用的局部或事件监听快捷键均无冲突。候选记录在 `test-results/shortcut-candidates.json`。系统组合参考 [Apple 快捷键说明](https://support.apple.com/en-us/102650)，注册使用 [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)。
- 原生事件实测发现托盘窗口出现但没有键盘焦点，修正为先结束热键事件回调，再显示、激活应用并聚焦窗口。未改变点击外部自动收起的行为。
- `pnpm test`：42 项通过；`pnpm build` 和最新 `pnpm typecheck` 通过。桌面回归 **22 项通过**，增加原生 Option + C 从另一个受控窗口唤出、聚焦输入框及隐藏的检查。UI 操作遇到自动收起时，测试先展开再操作；前面的真实失焦检查仍保留。
- 独立原生验证 **7 项通过**：旧设置迁移、默认注册、原生唤出/隐藏、收起后恢复、设置提示和重启恢复。结果在 `test-results/shortcut-validation.json`；使用 macOS CGEvent 模拟按键，未声称实体键盘已经按过。
- 正式 Clax 已启动，配置已保存为 Option + C。另用原生按键从独立受控进程唤出正式进程，并确认实际窗口可见、正式进程取得焦点；结果在 `test-results/shortcut-production-registration.json`。原 42 条消息逐条校验保留，Key 和 Provider 文件哈希一致，保留检查在 `test-results/shortcut-restart-validation.json`。
