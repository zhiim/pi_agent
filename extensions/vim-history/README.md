# Pi Vim History

针对 **Pi 1.1.0 全屏 TUI** 的轻量模式插件。没有修改 Pi 核心、现有 `settings.json`、`keybindings.json` 或其他扩展。

## 启用

插件已放在 `~/.pi/agent/extensions/vim-history/index.ts`，Pi 会自动发现。当前会话输入 `/reload`，或重新启动 Pi 即可加载。

单独调试（不加载其他扩展）：

```sh
pi --offline --no-extensions --extension ~/.pi/agent/extensions/vim-history --tui-mode fullscreen
```

插件在会话启动时自动启用，不注册 `/vim-history` 命令。若其他插件已替换编辑器，会提示而不是覆盖。

NORMAL 中要输入 Pi 命令，先按 `i` 或 `a`。

## 键位

初始状态为 **INSERT**。输入、补全、中文、粘贴和提交走 Pi 原有编辑器。

模式只显示在输入框右下角：**INSERT 使用主题成功色（通常为绿色），NORMAL 使用主题强调色**，随当前主题更新。最底部状态栏不再显示 `VIM INSERT` / `VIM NORMAL`；出现补全菜单时提示仍留在输入框下边框，不移动到补全列表。

| 模式 | 按键 | 动作 |
| --- | --- | --- |
| INSERT | `Esc` | 关闭补全（若有）并进入 NORMAL；这一下不会中断任务 |
| NORMAL | `k` / `j` | 历史向上 / 向下一行 |
| NORMAL | `Ctrl+u` / `Ctrl+d` | 历史向上 / 向下半个终端高度 |
| NORMAL | `G`（大写） | 到最新历史底部，恢复跟随输出；仍为 NORMAL |
| NORMAL | `i` / `a` | 回底部并进入 INSERT；不插入字母、不额外移动草稿光标 |
| NORMAL | `Esc` | Pi 原有中断路径；空输入时原有双 Esc 行为仍可能生效 |
| INSERT / NORMAL | `Ctrl+c` | 模型运行时立即中断，不主动清空草稿；空闲时保留 Pi 原有清空 / 连按退出行为 |

已移除 `[[` / `]]` 快捷键及消息级跳转功能。NORMAL 中方括号与其他普通字符一样被忽略，不滚动、不修改草稿；INSERT 中正常输入。Kitty 的按键释放不执行动作。

## NORMAL 的保护和保留行为

- 普通文本、Enter、Tab、删除、换行和 bracketed paste 不修改或提交草稿。
- `Ctrl+d` 不触发空输入退出，`Ctrl+u` 不删除草稿。
- 全屏中 `Ctrl+c` 优先通过公开的 `ctx.isIdle()` / `ctx.abort()` 中断正在运行的模型；INSERT 和 NORMAL 均生效，包括补全菜单打开时。中断不改变模式，也不主动清空草稿；若有排队消息，其恢复由 Pi 原生中断逻辑处理。空闲时仍保留原有清空 / 退出行为。
- bracketed paste 中的 `Ctrl+c` 是粘贴内容，不触发中断；Kitty 按键释放也不触发中断。
- 保留模型选择 / 切换、思考级别切换、工具和思考展开、复制、会话选择及后台挂起等非编辑类应用动作。
- 不放行图片粘贴、外部编辑器、排队发送或取回排队消息等会修改草稿 / 提交内容的动作。需要这些操作时进入 INSERT。
- 历史搜索、权限弹窗及模型 / 会话选择器拥有自己的焦点，不由 NORMAL 抢占。

## 实现与兼容边界

1. `CustomEditor` 子类负责模式和按键；NORMAL 只切换逻辑操作目标，仍使用宿主的输入入口。渲染时去除输入框 `CURSOR_MARKER`，INSERT 恢复光标 / IME 定位。
2. 使用公开的 `scrollBy()` / `scrollToBottom()` 操作原生全屏视口。半页按终端高度计算，并非扣除输入 dock 后的精确历史视口高度。
3. 不再读取用户消息组件树、测量消息布局、注册 Markdown transformer 或维护双键前缀；仅使用原生滚动接口。
4. 当前仍仅验证 Pi 1.1.0，对其他版本默认跳过启用；升级宿主前须重新测试兼容性。
5. `regular` 下保留普通输入；运行中切换到 regular 会恢复 INSERT。RPC、JSON、print 不安装 UI。
6. 全屏动作先于编辑器执行。如果把本插件键位全局绑定给全屏动作，会收到冲突提示；插件不会自行修改键位配置。
7. 模式切换保留同一个编辑器对象，因此不改变草稿光标或撤销栈。

## 开发与验证

没有新增运行时依赖。插件目录中仅有 TypeScript 与 Node 类型作为开发依赖。

```sh
cd ~/.pi/agent/extensions/vim-history
npm ci --ignore-scripts
npm run check
npm test
python3 scripts/smoke.py
SMOKE_SCROLLBAR=auto python3 scripts/smoke.py
SMOKE_SCROLLBAR=hidden python3 scripts/smoke.py
```

检查脚本自动找到实际 `pi` 命令的安装包，使用其模块和类型，而不是父扩展目录中旧版 Pi 的依赖。可通过 `PI_HOST_PACKAGE=/absolute/path/to/pi-coding-agent` 指定宿主。`check` 的 `skipLibCheck` 只跳过第三方声明检查，插件和测试仍使用 strict 类型检查。

PTY smoke 使用隔离临时 agent 目录、合成会话和 `--offline`，不读取用户凭据，不发模型请求；测试真正的 bundled Pi CLI、彩色输入框模式提示、底部状态栏模式文字移除（包括旧状态清理）、已移除的方括号快捷键不会触发滚动、保留键位、窗口缩放、reload，以及三种滚动条模式。额外注册纯本地 mock provider，验证 INSERT / NORMAL 中的 `Ctrl+c` 确实把 AbortSignal 传到运行中的模型流、结束 agent 运行且保留草稿，空闲时仍清空输入；不发网络请求，也不使用真实凭据。

仍建议在你的实际终端验证：中文输入法候选框、流式输出中导航与中断、真实权限弹窗、现有 `nvim-bridge` 和其他扩展共存。自动测试不能代替这些人工交互验证。
