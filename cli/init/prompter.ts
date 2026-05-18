import * as clack from "@clack/prompts"

export interface SelectOption<T> {
  value: T
  label: string
  hint?: string
}

export interface Prompter {
  intro(msg: string): void
  outro(msg: string): void
  text(opts: { message: string; defaultValue?: string; placeholder?: string; validate?: (v: string) => string | void }): Promise<string>
  confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>
  select<T>(opts: { message: string; options: SelectOption<T>[]; initialValue?: T }): Promise<T>
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

  async select<T>(opts: { message: string; options: SelectOption<T>[]; initialValue?: T }): Promise<T> {
    const r = await clack.select<T>({
      message: opts.message,
      options: opts.options as { value: T; label: string; hint?: string }[],
      initialValue: opts.initialValue,
    })
    if (clack.isCancel(r)) this.cancel()
    return r as T
  }

  cancel(msg = "cancelled"): never {
    clack.cancel(msg)
    process.exit(130)
  }
}

export interface ScriptedAnswers {
  text: string[]
  confirm: boolean[]
  select?: unknown[]
}

export class ScriptedPrompter implements Prompter {
  private textQueue: string[]
  private confirmQueue: boolean[]
  private selectQueue: unknown[]
  public log: string[] = []
  public lastSelectOptions: SelectOption<unknown>[] | null = null
  public confirmInitialValues: (boolean | undefined)[] = []

  constructor(answers: ScriptedAnswers) {
    this.textQueue = [...answers.text]
    this.confirmQueue = [...answers.confirm]
    this.selectQueue = answers.select ? [...answers.select] : []
  }

  intro(msg: string) { this.log.push(`intro: ${msg}`) }
  outro(msg: string) { this.log.push(`outro: ${msg}`) }

  async text(opts: { message: string; defaultValue?: string; placeholder?: string; validate?: (v: string) => string | void }): Promise<string> {
    if (this.textQueue.length === 0) {
      throw new Error(`no scripted text answer for prompt: ${opts.message}`)
    }
    return this.textQueue.shift()!
  }

  async confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean> {
    this.confirmInitialValues.push(opts.initialValue)
    if (this.confirmQueue.length === 0) {
      throw new Error(`no scripted confirm answer for prompt: ${opts.message}`)
    }
    return this.confirmQueue.shift()!
  }

  async select<T>(opts: { message: string; options: SelectOption<T>[]; initialValue?: T }): Promise<T> {
    this.lastSelectOptions = opts.options as SelectOption<unknown>[]
    if (this.selectQueue.length === 0) {
      throw new Error(`no scripted select answer for prompt: ${opts.message}`)
    }
    return this.selectQueue.shift() as T
  }

  cancel(msg = "cancelled"): never {
    throw new PrompterCancelled(msg)
  }
}
