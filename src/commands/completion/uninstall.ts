/**
 * hydra completion uninstall — Remove shell tab-completion scripts for hydra.
 *
 * Uses tabtab to:
 *   1. Remove ~/.config/tabtab/hydra.<shell>  (the per-package completion script)
 *   2. Remove the source line for hydra from ~/.config/tabtab/__tabtab.<shell>
 *   3. If the tabtab router is now empty, also remove its source line from the
 *      shell RC file (~/.bashrc / ~/.zshrc / etc.)
 */
import { Command } from '@oclif/core'
import { createRequire } from 'node:module'
import { logger } from '../../utils/logger.js'

const _require = createRequire(import.meta.url)

interface Tabtab {
  uninstall(options: { name: string }): Promise<void>
}

export default class CompletionUninstall extends Command {
  static override id = 'completion:uninstall'

  static override description = 'Remove shell tab-completion scripts for hydra'

  static override examples = ['<%= config.bin %> completion uninstall']

  async run(): Promise<void> {
    const tabtab = _require('tabtab') as Tabtab
    await tabtab.uninstall({ name: 'hydra' })
    logger.success('Shell completions removed.')
  }
}
