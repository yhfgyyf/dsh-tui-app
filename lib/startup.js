import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/**
 * The interactive app's command-line provider: it parses the optional
 * `--resume <id>` flag and `--help`, then publishes {@link TUI_STARTUP_SERVICE}.
 * The runner is an ordinary consumer whose lazy setup waits for that service.
 * @module dsh-tui-app/startup
 */

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the interactive runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/**
 * This app's command: the resume flag, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand() {
  return new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal chat with a DeepSeek Harness agent.')
    .helpOption('-h, --help', 'show this help')
    .option('-r, --resume <id>', 'resume an existing persisted session by id (see /sessions)')
    .option('-p, --preset <id>', 'agent preset for a new session (standard, code, minimal, cordis; auto when installed)')
    .addHelpText('after', `
Examples:
  dsh --profile tui                  start a new interactive session
  dsh --profile tui --preset standard start with the standalone default preset
  dsh --profile tui --preset auto    route the first prompt (requires Auto Router)
  dsh --profile tui --preset minimal start a new session in minimal mode
  dsh --profile tui --resume <id>    resume an existing session
`)
}

/**
 * Parse and provide the app flags as an ordinary Cordis service. The
 * command's action publishes the service; `--help` (and any parse error)
 * exits through the launcher's appExit instead.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx) {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts()
    if (options.resume !== undefined && options.preset !== undefined) {
      program.error('--preset cannot be used with --resume; a resumed session keeps its recorded preset')
      return
    }
    ctx.provide(TUI_STARTUP_SERVICE, { resume: options.resume, preset: options.preset })
  })
  parseCmdline(ctx, program)
}
