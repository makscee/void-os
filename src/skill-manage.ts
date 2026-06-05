// skill-manage.ts — guarded skill mutation engine (VOS-199, ADR-0002 §9).
// Phases: stage → validate → decision-gate → activate (on approve) / drop (on reject).
// ALL mutations park a Decision via VOS-194 emitDecisionAndPark; nothing goes live without
// operator approval.
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, renameSync,
  readdirSync, rmSync, appendFileSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseFrontmatter } from "./frontmatter.ts";
import { emitDecisionAndPark } from "./decision-emit.ts";
import { reconcileTriggers } from "./triggers-reconcile.ts";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Directory for in-flight staged transactions (quarantine). */
export const quarantineDir = (vault: string) =>
  join(vault, ".void-os", "skill-quarantine");

/** Path for a specific txn's staged SKILL.md. */
export const stagedSkillPath = (vault: string, txnId: string, name: string) =>
  join(quarantineDir(vault), txnId, "SKILL.md");

/** Path for a specific txn's metadata (action, name, extra). */
export const txnMetaPath = (vault: string, txnId: string) =>
  join(quarantineDir(vault), txnId, "txn.json");

/** Live skill dir in the vault's .claude/skills (where CC looks). */
export const vaultSkillDir = (vault: string, name: string) =>
  join(vault, ".claude", "skills", name);

/** Live SKILL.md path in the vault. */
export const vaultSkillPath = (vault: string, name: string) =>
  join(vaultSkillDir(vault, name), "SKILL.md");

/** Trigger file path in the vault. */
export const vaultTriggerPath = (vault: string, name: string) =>
  join(vault, "triggers", `${name}.md`);

/** Audit log. */
export const auditLogPath = (vault: string) =>
  join(vault, ".void-os", "skill-audit.log");

/** Bundled-manifest baseline path. */
export const manifestPath = (vault: string) =>
  join(vault, ".void-os", "skill-manifest.json");

// ---------------------------------------------------------------------------
// Manifest baseline (for rollback)
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  name: string;
  version: string;
  body: string; // full SKILL.md text
}

/** Build + write a baseline manifest from the current live skills. */
export function writeManifest(vault: string): void {
  const entries: ManifestEntry[] = [];
  const skillsDir = join(vault, ".claude", "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(p)) continue;
      const body = readFileSync(p, "utf8");
      const meta = parseFrontmatter(body);
      entries.push({ name: entry.name, version: meta.version ?? "0.0.0", body });
    }
  }
  mkdirSync(dirname(manifestPath(vault)), { recursive: true });
  writeFileSync(manifestPath(vault), JSON.stringify(entries, null, 2) + "\n");
}

/** Read the baseline manifest (returns [] if absent). */
export function readManifest(vault: string): ManifestEntry[] {
  const p = manifestPath(vault);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, "utf8")) as ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const REQUIRED_SECTIONS = ["## Instructions"];

/** Validate a staged skill's SKILL.md. Returns {ok, errors[]}. */
export function validateStaged(vault: string, txnId: string): ValidationResult {
  const p = stagedSkillPath(vault, txnId, "");
  if (!existsSync(p)) {
    return { ok: false, errors: [`staged SKILL.md not found at ${p}`] };
  }
  const body = readFileSync(p, "utf8");
  const errors: string[] = [];

  // 1. Frontmatter parses + required fields non-empty
  const meta = parseFrontmatter(body);
  if (!meta.name) errors.push("frontmatter: missing or empty `name`");
  if (!meta.description) errors.push("frontmatter: missing or empty `description`");

  // 2. Required sections
  for (const sec of REQUIRED_SECTIONS) {
    if (!body.includes(sec)) errors.push(`missing required section: ${sec}`);
  }

  // 3. output_target glob: if present, must look like a valid vault-relative glob
  if (meta.outputTarget) {
    const t = meta.outputTarget.trim();
    if (t.startsWith("/") || t.includes("..")) {
      errors.push(`output_target must be vault-relative (no leading / or ..): ${t}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Semver bump helper
// ---------------------------------------------------------------------------

function bumpPatch(v: string): string {
  const parts = v.split(".");
  const patch = parseInt(parts[2] ?? "0", 10);
  return `${parts[0] ?? "0"}.${parts[1] ?? "0"}.${isNaN(patch) ? 1 : patch + 1}`;
}

function injectVersion(body: string, version: string): string {
  if (/^version:/m.test(body)) {
    return body.replace(/^version:.*$/m, `version: ${version}`);
  }
  // Inject before closing ---
  return body.replace(/^(---\n[\s\S]*?\n)---/m, `$1version: ${version}\n---`);
}

// ---------------------------------------------------------------------------
// Activate staged
// ---------------------------------------------------------------------------

export interface ActivateResult {
  skillPath: string;
  triggerWritten: boolean;
  version: string;
}

/** Move a valid staged txn into the live vault skill dir. Writes trigger if bus-bound.
 *  Fires reconcileTriggers in-process so kind= routing goes live with NO restart. */
export function activateStaged(
  vault: string,
  txnId: string,
  db: Database,
  now: number = Date.now(),
): ActivateResult {
  const txnMeta = readTxnMeta(vault, txnId);
  const stagedSrc = stagedSkillPath(vault, txnId, txnMeta.name);
  const body = readFileSync(stagedSrc, "utf8");

  // Bump semver
  const meta = parseFrontmatter(body);
  const priorVersion = meta.version ?? "0.0.0";
  const newVersion = bumpPatch(priorVersion);
  const finalBody = injectVersion(body, newVersion);

  // Atomic write into live vault
  const dest = vaultSkillPath(vault, txnMeta.name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, finalBody);

  // If bus-bound (trigger field in txnMeta), write trigger file
  let triggerWritten = false;
  if (txnMeta.trigger) {
    const trigPath = vaultTriggerPath(vault, txnMeta.name);
    mkdirSync(dirname(trigPath), { recursive: true });
    writeFileSync(trigPath, txnMeta.trigger);
    triggerWritten = true;
  }

  // In-process reconcile (no restart needed)
  try { reconcileTriggers(db, vault, now); } catch { /* non-fatal */ }

  // Audit log
  appendAuditLine(vault, {
    at: now, action: txnMeta.action, name: txnMeta.name, version: newVersion, txnId,
  });

  // Clean quarantine
  rmSync(join(quarantineDir(vault), txnId), { recursive: true, force: true });

  return { skillPath: dest, triggerWritten, version: newVersion };
}

// ---------------------------------------------------------------------------
// Txn metadata
// ---------------------------------------------------------------------------

export type SkillAction = "create" | "patch" | "edit" | "delete" | "write_file";

export interface TxnMeta {
  txnId: string;
  action: SkillAction;
  name: string;
  trigger?: string; // trigger file body, if bus-bound
  createdAt: number;
}

function readTxnMeta(vault: string, txnId: string): TxnMeta {
  const p = txnMetaPath(vault, txnId);
  if (!existsSync(p)) throw new Error(`txn meta not found: ${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as TxnMeta;
}

function writeTxnMeta(vault: string, meta: TxnMeta): void {
  const p = txnMetaPath(vault, meta.txnId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(meta) + "\n");
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function appendAuditLine(
  vault: string,
  entry: { at: number; action: string; name: string; version: string; txnId: string },
): void {
  const p = auditLogPath(vault);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
}

// ---------------------------------------------------------------------------
// Stage helpers — write SKILL.md body into quarantine txn dir
// ---------------------------------------------------------------------------

function stageBody(vault: string, txnId: string, body: string, meta: TxnMeta): void {
  const dir = join(quarantineDir(vault), txnId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stagedSkillPath(vault, txnId, meta.name), body);
  writeTxnMeta(vault, meta);
}

// ---------------------------------------------------------------------------
// Mutation stage + decision-gate
// ---------------------------------------------------------------------------

/** Common result returned by every gate call — the decision id and txn id. */
export interface GateResult {
  txnId: string;
  decisionId: string;
  intentPath: string;
  status: "parked";
}

export interface CreateOpts {
  execId: string; // the CC execution calling skill_manage
  name: string;
  body: string;
  trigger?: string; // optional trigger file body
  resumeSkill?: string;
  resumeAgent?: string;
  now?: number;
}

/** Stage a create + emit a Decision + park. Returns immediately. */
export function gateCreate(vault: string, opts: CreateOpts): GateResult {
  const txnId = `skm-${randomUUID()}`;
  const now = opts.now ?? Date.now();
  const meta: TxnMeta = {
    txnId, action: "create", name: opts.name, trigger: opts.trigger, createdAt: now,
  };
  stageBody(vault, txnId, opts.body, meta);

  const diff = `--- /dev/null\n+++ ${opts.name}/SKILL.md\n${opts.body}`;
  const { decision, intentPath } = emitDecisionAndPark(vault, {
    execId: opts.execId,
    question: `approve create skill ${opts.name}?`,
    options: ["approve", "reject"],
    context: diff,
    resumeSkill: opts.resumeSkill ?? "skill-manage-apply",
    resumeAgent: opts.resumeAgent ?? "default",
    resumePayload: JSON.stringify({ txnId, action: "create", name: opts.name }),
    now,
  });

  return { txnId, decisionId: decision.id, intentPath, status: "parked" };
}

export interface PatchOpts {
  execId: string;
  name: string;
  oldBody: string; // prior content (for diff context)
  newBody: string; // desired new content
  trigger?: string;
  resumeSkill?: string;
  resumeAgent?: string;
  now?: number;
}

/** Stage a patch (old→new) + emit Decision + park. */
export function gatePatch(vault: string, opts: PatchOpts): GateResult {
  const txnId = `skm-${randomUUID()}`;
  const now = opts.now ?? Date.now();
  const meta: TxnMeta = {
    txnId, action: "patch", name: opts.name, trigger: opts.trigger, createdAt: now,
  };
  stageBody(vault, txnId, opts.newBody, meta);

  // Build a simple diff context (hermes: patch preferred for tweaks)
  const diff = `--- a/${opts.name}/SKILL.md\n+++ b/${opts.name}/SKILL.md\n[old]\n${opts.oldBody}\n[new]\n${opts.newBody}`;
  const { decision, intentPath } = emitDecisionAndPark(vault, {
    execId: opts.execId,
    question: `approve patch skill ${opts.name}?`,
    options: ["approve", "reject"],
    context: diff,
    resumeSkill: opts.resumeSkill ?? "skill-manage-apply",
    resumeAgent: opts.resumeAgent ?? "default",
    resumePayload: JSON.stringify({ txnId, action: "patch", name: opts.name }),
    now,
  });

  return { txnId, decisionId: decision.id, intentPath, status: "parked" };
}

export interface EditOpts {
  execId: string;
  name: string;
  body: string; // full replacement body
  trigger?: string;
  resumeSkill?: string;
  resumeAgent?: string;
  now?: number;
}

/** Stage a full edit + emit Decision + park. */
export function gateEdit(vault: string, opts: EditOpts): GateResult {
  const txnId = `skm-${randomUUID()}`;
  const now = opts.now ?? Date.now();
  const meta: TxnMeta = {
    txnId, action: "edit", name: opts.name, trigger: opts.trigger, createdAt: now,
  };
  stageBody(vault, txnId, opts.body, meta);

  const { decision, intentPath } = emitDecisionAndPark(vault, {
    execId: opts.execId,
    question: `approve edit skill ${opts.name}?`,
    options: ["approve", "reject"],
    context: `full rewrite of ${opts.name}/SKILL.md:\n${opts.body}`,
    resumeSkill: opts.resumeSkill ?? "skill-manage-apply",
    resumeAgent: opts.resumeAgent ?? "default",
    resumePayload: JSON.stringify({ txnId, action: "edit", name: opts.name }),
    now,
  });

  return { txnId, decisionId: decision.id, intentPath, status: "parked" };
}

export interface DeleteOpts {
  execId: string;
  name: string;
  resumeSkill?: string;
  resumeAgent?: string;
  now?: number;
}

/** Gate a skill delete. Stages a sentinel file + emits Decision. */
export function gateDelete(vault: string, opts: DeleteOpts): GateResult {
  const txnId = `skm-${randomUUID()}`;
  const now = opts.now ?? Date.now();
  const meta: TxnMeta = { txnId, action: "delete", name: opts.name, createdAt: now };
  // Stage a sentinel (no SKILL.md staged — activate will detect delete action)
  const dir = join(quarantineDir(vault), txnId);
  mkdirSync(dir, { recursive: true });
  writeTxnMeta(vault, meta);

  const { decision, intentPath } = emitDecisionAndPark(vault, {
    execId: opts.execId,
    question: `approve delete skill ${opts.name}?`,
    options: ["approve", "reject"],
    context: `delete ${opts.name} from vault skills`,
    resumeSkill: opts.resumeSkill ?? "skill-manage-apply",
    resumeAgent: opts.resumeAgent ?? "default",
    resumePayload: JSON.stringify({ txnId, action: "delete", name: opts.name }),
    now,
  });

  return { txnId, decisionId: decision.id, intentPath, status: "parked" };
}

export interface WriteFileOpts {
  execId: string;
  name: string; // skill name
  filePath: string; // vault-relative sub-path inside the skill dir
  content: string;
  resumeSkill?: string;
  resumeAgent?: string;
  now?: number;
}

/** Gate writing an arbitrary file into a skill dir (e.g. assets, examples). */
export function gateWriteFile(vault: string, opts: WriteFileOpts): GateResult {
  const txnId = `skm-${randomUUID()}`;
  const now = opts.now ?? Date.now();
  const meta: TxnMeta = { txnId, action: "write_file", name: opts.name, createdAt: now };
  const dir = join(quarantineDir(vault), txnId);
  mkdirSync(dir, { recursive: true });
  // Write the staged file at the declared sub-path
  const dest = join(dir, opts.filePath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, opts.content);
  writeTxnMeta(vault, { ...meta, trigger: undefined } as TxnMeta);

  const { decision, intentPath } = emitDecisionAndPark(vault, {
    execId: opts.execId,
    question: `approve write_file ${opts.filePath} in skill ${opts.name}?`,
    options: ["approve", "reject"],
    context: `write ${opts.filePath}:\n${opts.content.slice(0, 500)}`,
    resumeSkill: opts.resumeSkill ?? "skill-manage-apply",
    resumeAgent: opts.resumeAgent ?? "default",
    resumePayload: JSON.stringify({ txnId, action: "write_file", name: opts.name, filePath: opts.filePath }),
    now,
  });

  return { txnId, decisionId: decision.id, intentPath, status: "parked" };
}

// ---------------------------------------------------------------------------
// Activate for delete action
// ---------------------------------------------------------------------------

/** Recursively copy all files from srcDir to destDir, skipping top-level filenames in skip[]. */
function copyDirRecursive(srcDir: string, destDir: string, skip: string[] = []): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dst = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(src));
    }
  }
}

/** Apply approved mutation: routes by action. For delete: removes the live skill dir. */
export function applyApprovedTxn(
  vault: string,
  txnId: string,
  db: Database,
  now: number = Date.now(),
): ActivateResult | { deleted: true; name: string } {
  const meta = readTxnMeta(vault, txnId);

  if (meta.action === "delete") {
    const liveDir = vaultSkillDir(vault, meta.name);
    if (existsSync(liveDir)) rmSync(liveDir, { recursive: true, force: true });
    // Also remove trigger file if it exists
    const trigPath = vaultTriggerPath(vault, meta.name);
    if (existsSync(trigPath)) rmSync(trigPath, { force: true });
    try { reconcileTriggers(db, vault, now); } catch { /* non-fatal */ }
    appendAuditLine(vault, { at: now, action: "delete", name: meta.name, version: "-", txnId });
    rmSync(join(quarantineDir(vault), txnId), { recursive: true, force: true });
    return { deleted: true, name: meta.name };
  }

  if (meta.action === "write_file") {
    // Recursively copy all quarantine files (except txn.json) to the vault skill dir
    const qDir = join(quarantineDir(vault), txnId);
    const destBase = vaultSkillDir(vault, meta.name);
    copyDirRecursive(qDir, destBase, ["txn.json"]);
    appendAuditLine(vault, { at: now, action: "write_file", name: meta.name, version: "-", txnId });
    rmSync(join(quarantineDir(vault), txnId), { recursive: true, force: true });
    return { skillPath: join(destBase, ""), triggerWritten: false, version: "-" };
  }

  // create / patch / edit → activateStaged
  return activateStaged(vault, txnId, db, now);
}

// ---------------------------------------------------------------------------
// Drop (reject)
// ---------------------------------------------------------------------------

/** Drop a staged txn cleanly: remove quarantine dir + audit-log the rejection. */
export function dropTxn(vault: string, txnId: string, now: number = Date.now()): void {
  const dir = join(quarantineDir(vault), txnId);
  let name = txnId;
  let action = "reject";
  try {
    const meta = readTxnMeta(vault, txnId);
    name = meta.name;
    action = `reject-${meta.action}`;
  } catch { /* meta may not exist if already dropped */ }
  appendAuditLine(vault, { at: now, action, name, version: "-", txnId });
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/** Restore a skill to its baseline manifest version. Re-reconciles triggers. */
export function revertSkill(vault: string, name: string, db: Database, now: number = Date.now()): void {
  const manifest = readManifest(vault);
  const entry = manifest.find((e) => e.name === name);
  if (!entry) throw new Error(`revertSkill: ${name} not in manifest baseline`);
  const dest = vaultSkillPath(vault, name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, entry.body);
  try { reconcileTriggers(db, vault, now); } catch { /* non-fatal */ }
  appendAuditLine(vault, { at: now, action: "revert", name, version: entry.version, txnId: "-" });
}

// ---------------------------------------------------------------------------
// Read-only helpers (for MCP surface)
// ---------------------------------------------------------------------------

export interface LiveSkillSummary {
  name: string;
  description: string;
  version: string;
}

/**
 * System-primitive skills seeded by init — NOT user/catalog skills.
 * They stay on disk (required for in-vault authoring) but must not appear in
 * the dashboard skill list. Single source of truth: init.ts imports this
 * constant instead of duplicating the names.
 */
export const SYSTEM_PRIMITIVE_SKILLS: ReadonlySet<string> = new Set([
  "skill-author",
  "skill-manage-apply",
]);

/** List all skills currently installed in the vault. */
export function listVaultSkills(vault: string): LiveSkillSummary[] {
  const skillsDir = join(vault, ".claude", "skills");
  if (!existsSync(skillsDir)) return [];
  const result: LiveSkillSummary[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(p)) continue;
    const meta = parseFrontmatter(readFileSync(p, "utf8"));
    result.push({
      name: entry.name,
      description: meta.description,
      version: meta.version ?? "0.0.0",
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Dashboard-safe skill list: identical to listVaultSkills but with
 * SYSTEM_PRIMITIVE_SKILLS filtered out. The primitives remain on disk and
 * are still accessible via listVaultSkills (MCP / authoring path).
 */
export function listVaultSkillsForDisplay(vault: string): LiveSkillSummary[] {
  return listVaultSkills(vault).filter(
    (s) => !SYSTEM_PRIMITIVE_SKILLS.has(s.name),
  );
}

/** Return the raw SKILL.md body for one vault skill. */
export function viewVaultSkill(vault: string, name: string): string | null {
  const p = vaultSkillPath(vault, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}
