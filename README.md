# DSH TUI App

[简体中文](README.zh-CN.md)

A readline-based interactive terminal profile bundle for DeepSeek Harness.
It keeps DSH's model, Agent Preset, session, permission, command, and tool
services, and supplies a terminal chat surface over them.

This is an independent lightweight implementation. It is not the React/Ink
project published as [`ccch1mneyyy/dsh-TUI`](https://github.com/ccch1mneyyy/dsh-TUI).

## Preview

![DSH TUI startup screen](docs/assets/tui-startup.png)

The image shows a real local `dsh --profile tui` startup rendered from an
isolated profile and the disposable `/private/tmp/dsh-tui-demo` workspace. It
contains no user name, home-directory path, session ID, or personal project
information.

## Features

- Streaming assistant text, reasoning, tool calls, and tool results.
- Bordered TTY composer with command completion, history, resize reflow, and a
  plain line-loop fallback when stdin/stdout are pipes.
- New, resume, list, and delete session flows over DSH's durable session store.
- Blank-session Agent Preset selection; the preset is locked after the first
  model-loop turn.
- Model and reasoning-effort pickers, plus permission-preset cycling with
  Shift+Tab.
- DSH slash-command registry integration and an explicit `!<command>` local
  shell shortcut.

## Install

Requires DeepSeek Harness `0.1.0-rc.6` or a compatible later build.

```sh
dsh plugin --profile tui add github:yhfgyyf/dsh-tui-app
dsh --profile tui
```

The first command creates the `tui` profile when it does not exist, adds this
package as a standard `dsh.bundle`, and records it in that profile.

Startup options:

```sh
dsh --profile tui --help
dsh --profile tui --preset minimal
dsh --profile tui --resume <session-id>
```

The standalone default is `standard`. To make first-prompt automatic routing
available and default, install the router bundle after this TUI bundle:

```sh
dsh plugin --profile tui add github:yhfgyyf/dsh-auto-preset-router
dsh --profile tui --preset auto
```

## Commands and keys

Local commands include `/help`, `/sessions`, `/resume`, `/preset`, `/new`,
`/model`, `/effort`, and `/exit`. DSH application commands such as `/compact`,
`/goal`, `/feedback`, and `/export` are merged from the shared command
registry when their providers are composed.

Main keys: Enter sends, Up/Down navigate history or pickers, Tab completes,
Shift+Tab cycles permission presets, Esc interrupts/closes, Ctrl+L clears, and
Ctrl+D exits.

## Security boundary

`!<command>` is an explicit human-operated shell escape. It launches the
user's shell directly in the current workspace and therefore does **not** pass
through the Agent tool sandbox or approval policy. Only run commands you trust.
The ordinary model-driven shell tools remain governed by the active DSH preset
and permission configuration.

Like any DSH plugin, this package runs with the permissions of the DSH process.

## Remove

Remove the Auto Router first if it was installed into the same profile:

```sh
dsh plugin --profile tui remove dsh-auto-preset-router
dsh plugin --profile tui remove dsh-tui-app
```

Session data under `$DSH_HOME` is not deleted.

## Development

```sh
npm test
npm run check
npm run pack:check
```

The repository follows the current DSH distribution contract: `package.json`
declares `dsh.bundle.patch`, and `cordis.patch.yml` composes the terminal app
through `dsh plugin --profile … add …`.
