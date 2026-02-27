/**
 * hydra completion install — Install shell tab-completion for the hydra CLI.
 *
 * Detects the current shell from $SHELL, then uses tabtab's installer to:
 *   1. Write a per-package completion script to ~/.config/tabtab/hydra.<shell>
 *   2. Source that script from the tabtab router (~/.config/tabtab/__tabtab.<shell>)
 *   3. Source the tabtab router from the user's shell RC file (~/.bashrc / ~/.zshrc / etc.)
 *
 * After installation the user must restart their terminal (or `source` the RC file)
 * to activate completions.
 */
import { Command } from '@oclif/core'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from '../../utils/logger.js'

const _require = createRequire(import.meta.url)

interface TabtabInstaller {
  install(options: { name: string; completer: string; location: string }): Promise<void>
}

export default class CompletionInstall extends Command {
  static override id = 'completion:install'

  static override description =
    'Install shell tab-completion scripts for hydra (bash, zsh, or fish)'

  static override examples = ['<%= config.bin %> completion install']

  async run(): Promise<void> {
    // Detect shell from $SHELL env var (e.g. "/bin/zsh" → "zsh")
    const shellBin = process.env.SHELL ?? '/bin/bash'
    const shell = shellBin.split('/').at(-1) ?? 'bash'
    const home = os.homedir()

    // Map shell → RC file location (mirrors tabtab's locationFromShell())
    let location: string
    if (shell === 'zsh') {
      location = path.join(home, '.zshrc')
    } else if (shell === 'fish') {
      location = path.join(home, '.config', 'fish', 'config.fish')
    } else {
      // bash (and any unknown shell)
      location = path.join(home, '.bashrc')
    }

    const installer = _require('tabtab/lib/installer') as TabtabInstaller
    await installer.install({ name: 'hydra', completer: 'hydra', location })

    logger.success(`Shell completions installed for ${shell}. Restart your terminal to activate.`)
  }
}
