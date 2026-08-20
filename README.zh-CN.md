# DSH 轻量 TUI

[English](README.md)

这是一个基于 Node readline 的 DeepSeek Harness 交互式终端 profile bundle。
模型、Agent Preset、会话、权限、命令与工具仍由 DSH 服务负责，本插件提供终端
聊天界面。

这是独立的轻量实现，不是 React/Ink 架构的
[`ccch1mneyyy/dsh-TUI`](https://github.com/ccch1mneyyy/dsh-TUI)。

## 功能

- 流式显示回答、思考、工具调用与工具结果。
- TTY 下提供固定边框输入框、命令补全、历史记录与窗口缩放重排；管道输入输出时
  自动退化为普通逐行循环。
- 基于 DSH 持久会话存储的新建、恢复、列表与删除流程。
- 空白会话可选择 Agent Preset；第一次模型回合开始后锁定，不能中途切换。
- 模型与推理强度选择器，Shift+Tab 循环权限 preset。
- 合并 DSH slash-command 注册表，并提供显式的 `!<command>` 本地 shell 快捷方式。

## 安装

要求 DeepSeek Harness `0.1.0-rc.6` 或兼容的后续版本。

```sh
dsh plugin --profile tui add github:yhfgyyf/dsh-tui-app
dsh --profile tui
```

当 `tui` profile 不存在时，第一条命令会创建它，并把本包作为标准
`dsh.bundle` 写入该 profile。

启动参数：

```sh
dsh --profile tui --help
dsh --profile tui --preset minimal
dsh --profile tui --resume <session-id>
```

单独安装时默认使用 `standard`。如需新增并默认使用第一条 prompt 自动路由，请在
TUI 之后安装 Auto Router bundle：

```sh
dsh plugin --profile tui add github:yhfgyyf/dsh-auto-preset-router
dsh --profile tui --preset auto
```

## 命令与按键

本地命令包括 `/help`、`/sessions`、`/resume`、`/preset`、`/new`、
`/model`、`/effort` 和 `/exit`。当相应 provider 已组装时，`/compact`、
`/goal`、`/feedback`、`/export` 等 DSH 应用命令会从共享注册表自动加入。

主要按键：Enter 发送，↑/↓ 浏览历史或选择项目，Tab 补全，Shift+Tab 循环权限，
Esc 中断或关闭菜单，Ctrl+L 清屏，Ctrl+D 退出。

## 安全边界

`!<command>` 是用户主动触发的 shell escape：它会在当前 workspace 中直接启动
用户 shell，**不会**经过 Agent 工具沙箱或审批策略。只应执行你信任的命令。
模型使用的普通 shell 工具仍由当前 DSH preset 与权限设置管理。

与其他 DSH 插件一样，本插件代码拥有 DSH 进程本身的权限。

## 卸载

如果同一 profile 安装了 Auto Router，请先卸载它：

```sh
dsh plugin --profile tui remove dsh-auto-preset-router
dsh plugin --profile tui remove dsh-tui-app
```

卸载不会删除 `$DSH_HOME` 下的会话数据。

## 开发与验证

```sh
npm test
npm run check
npm run pack:check
```

仓库采用当前 DSH 插件分发规范：`package.json` 声明
`dsh.bundle.patch`，由 `cordis.patch.yml` 通过
`dsh plugin --profile … add …` 组装。
