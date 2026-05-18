import * as clack from "@clack/prompts"

export interface Prompter {
  intro(msg: string): void
  outro(msg: string): void
  text(opts: { message: string; defaultValue?: string; placeholder?: string; validate?: (v: string) => string | void }): Promise<string>
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>
  cancel(msg?: string): never
}

export class PrompterCancelled extends Error {
  constructor(msg = "cancelled") { super(msg) }
}

export class ClackPrompter implements Prompter {
  intro(msg: string) { clack.intro(msg) }
  outro(msg: string) { clack.outro(msg) }

  async text(opts: { message: string; defaultValue?: string; placeholder?: string; validate?: (v: string) => string | void }) {
    const r = await clack.text({
      message: opts.message,
      defaultValue: opts.defaultValue,
      placeholder: opts.placeholder ?? opts.defaultValue,
      validate: opts.validate,
    })
    if (clack.isCancel(r)) this.cancel()
    return r as string
  }

  async confirm(opts: { message: string; initialValue?: boolean }) {
    const r = await clack.confirm({ message: opts.message, initialValue: opts.initialValue })
    if (clack.isCancel(r)) this.cancel()
    return r as boolean
  }

  cancel(msg = "cancelled"): never {
    clack.cancel(msg)
    process.exit(130)
  }
}

export interface ScriptedAnswers {
  text: string[]
  confirm: boolean[]
}

export class ScriptedPrompter implements Prompter {
  private textQueue: string[]
  private confirmQueue: boolean[]
  public log: string[] = []

  constructor(answers: ScriptedAnswers) {
    this.textQueue = [...answers.text]
    this.confirmQueue = [...answers.confirm]
  }

  intro(msg: string) { this.log.push(`intro: ${msg}`) }
  outro(msg: string) { this.log.push(`outro: ${msg}`) }

  async text(opts: { message: string; defaultValue?: string; placeholder?: string }): Promise<string> {
    if (this.textQueue.length === 0) {
      throw new Error(`no scripted text answer for prompt: ${opts.message}`)
    }
    return this.textQueue.shift()!
  }

  async confirm(opts: { message: string }): Promise<boolean> {
    if (this.confirmQueue.length === 0) {
      throw new Error(`no scripted confirm answer for prompt: ${opts.message}`)
    }
    return this.confirmQueue.shift()!
  }

  cancel(msg = "cancelled"): never {
    throw new PrompterCancelled(msg)
  }
}
