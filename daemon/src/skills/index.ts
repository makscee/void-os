// Skill loader. Reads vault/skills/<name>/SKILL.md, exposes run_skill.

export interface SkillDescriptor {
  name: string;
  description: string;
  surface: "plugin" | "agent" | "trigger";
  inputs: Record<string, { type: string; required?: boolean }>;
}

export interface SkillLoader {
  list(): Promise<SkillDescriptor[]>;
  get(name: string): Promise<SkillDescriptor | null>;
  run(name: string, inputs: Record<string, unknown>, chatId?: string): Promise<{ runId: string }>;
}

export const createSkillLoader = (): SkillLoader => {
  throw new Error("not implemented");
};
