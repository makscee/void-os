// tests/skill-manage.test.ts — VOS-199 Phase 1 unit tests for the skill_manage engine.
// TDD: verifies staging, validation, decision-gating, activation, reject, rollback.
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  gateCreate, gatePatch, gateEdit, gateDelete, gateWriteFile,
  validateStaged, activateStaged, applyApprovedTxn, dropTxn, revertSkill,
  listVaultSkills, listVaultSkillsForDisplay, viewVaultSkill,
  SYSTEM_PRIMITIVE_SKILLS,
  quarantineDir, vaultSkillPath, auditLogPath, manifestPath,
  writeManifest, readManifest,
  txnMetaPath, stagedSkillPath,
} from "../src/skill-manage.ts";
import { listPendingDecisions } from "../src/decision.ts";
import { readResumptionIntent } from "../src/decision-emit.ts";
import { openRegistry } from "../src/registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpVault(): string {
  return mkdtempSync(join(tmpdir(), "vos199-"));
}

function tmpDb(): Database {
  return openRegistry(":memory:");
}

const GOOD_SKILL_BODY = `---
name: test-skill
description: A test skill
version: 1.0.0
output_target: .void-os/test-out/*.json
---

## Instructions

Do something useful.
`;

const SKILL_MISSING_INSTRUCTIONS = `---
name: bad-skill
description: Missing required section
version: 1.0.0
---

## Notes

No instructions here.
`;

const SKILL_MISSING_NAME = `---
description: No name
version: 1.0.0
---

## Instructions

Do things.
`;

// ---------------------------------------------------------------------------
// Phase 1A: staging + validate
// ---------------------------------------------------------------------------

test("gateCreate stages SKILL.md in quarantine + appends a pending Decision", () => {
  const vault = tmpVault();
  const execId = "ex-test-create-001";
  const result = gateCreate(vault, {
    execId,
    name: "test-skill",
    body: GOOD_SKILL_BODY,
    now: Date.now(),
  });

  expect(result.status).toBe("parked");
  expect(result.txnId).toMatch(/^skm-/);
  expect(result.decisionId).toMatch(/^dl-/);

  // Quarantine SKILL.md must exist
  const staged = stagedSkillPath(vault, result.txnId, "test-skill");
  expect(existsSync(staged)).toBe(true);
  expect(readFileSync(staged, "utf8")).toContain("test-skill");

  // txn.json must exist with correct action
  const meta = JSON.parse(readFileSync(txnMetaPath(vault, result.txnId), "utf8"));
  expect(meta.action).toBe("create");
  expect(meta.name).toBe("test-skill");

  // Decision must be pending
  const pending = listPendingDecisions(vault);
  expect(pending.some((d) => d.id === result.decisionId)).toBe(true);
  const dec = pending.find((d) => d.id === result.decisionId)!;
  expect(dec.question).toContain("test-skill");

  // Resumption intent must be written (keyed by decisionId, not execId)
  const intent = readResumptionIntent(vault, result.decisionId);
  expect(intent.decisionId).toBe(result.decisionId);
  const payload = JSON.parse(intent.resumePayload);
  expect(payload.txnId).toBe(result.txnId);
  expect(payload.action).toBe("create");
});

test("validateStaged passes a well-formed SKILL.md", () => {
  const vault = tmpVault();
  const result = gateCreate(vault, {
    execId: "ex-val-001",
    name: "test-skill",
    body: GOOD_SKILL_BODY,
  });
  const val = validateStaged(vault, result.txnId);
  expect(val.ok).toBe(true);
  expect(val.errors).toHaveLength(0);
});

test("validateStaged fails when ## Instructions is missing", () => {
  const vault = tmpVault();
  const result = gateCreate(vault, {
    execId: "ex-val-002",
    name: "bad-skill",
    body: SKILL_MISSING_INSTRUCTIONS,
  });
  const val = validateStaged(vault, result.txnId);
  expect(val.ok).toBe(false);
  expect(val.errors.some((e) => e.includes("Instructions"))).toBe(true);
});

test("validateStaged fails when name is empty", () => {
  const vault = tmpVault();
  const result = gateCreate(vault, {
    execId: "ex-val-003",
    name: "bad-skill",
    body: SKILL_MISSING_NAME,
  });
  const val = validateStaged(vault, result.txnId);
  expect(val.ok).toBe(false);
  expect(val.errors.some((e) => e.includes("name"))).toBe(true);
});

test("validateStaged fails when output_target has absolute path", () => {
  const vault = tmpVault();
  const badBody = GOOD_SKILL_BODY.replace("output_target: .void-os/test-out/*.json", "output_target: /absolute/path/*.json");
  const result = gateCreate(vault, { execId: "ex-val-004", name: "test-skill", body: badBody });
  const val = validateStaged(vault, result.txnId);
  expect(val.ok).toBe(false);
  expect(val.errors.some((e) => e.includes("vault-relative"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Phase 1B: activateStaged + live routing
// ---------------------------------------------------------------------------

test("activateStaged moves SKILL.md to live vault, bumps semver, writes audit line", () => {
  const vault = tmpVault();
  const db = tmpDb();
  const result = gateCreate(vault, {
    execId: "ex-act-001",
    name: "test-skill",
    body: GOOD_SKILL_BODY,
    now: 1000,
  });

  const activation = activateStaged(vault, result.txnId, db, 2000);
  expect(activation.version).toBe("1.0.1");
  expect(existsSync(activation.skillPath)).toBe(true);

  const live = readFileSync(activation.skillPath, "utf8");
  expect(live).toContain("version: 1.0.1");

  // Quarantine dir cleaned up
  const qDir = join(quarantineDir(vault), result.txnId);
  expect(existsSync(qDir)).toBe(false);

  // Audit line written
  expect(existsSync(auditLogPath(vault))).toBe(true);
  const auditLines = readFileSync(auditLogPath(vault), "utf8").trim().split("\n");
  const entry = JSON.parse(auditLines[0]);
  expect(entry.action).toBe("create");
  expect(entry.name).toBe("test-skill");
  expect(entry.version).toBe("1.0.1");
});

test("activateStaged with trigger writes trigger file and is listed in skills", () => {
  const vault = tmpVault();
  const db = tmpDb();
  mkdirSync(join(vault, "triggers"), { recursive: true });

  const trigBody = "---\nkind: event\nskill: test-skill\nagent: default\ninbox: bus\nevent_kind: test\nstep_ceiling: 10\n---\n";
  const result = gateCreate(vault, {
    execId: "ex-trig-001",
    name: "test-skill",
    body: GOOD_SKILL_BODY,
    trigger: trigBody,
  });

  const activation = activateStaged(vault, result.txnId, db);
  expect(activation.triggerWritten).toBe(true);

  const trigPath = join(vault, "triggers", "test-skill.md");
  expect(existsSync(trigPath)).toBe(true);
});

// ---------------------------------------------------------------------------
// Phase 1C: gatePatch / gateEdit
// ---------------------------------------------------------------------------

test("gatePatch stages new body + parks a patch Decision", () => {
  const vault = tmpVault();
  const oldBody = GOOD_SKILL_BODY;
  const newBody = GOOD_SKILL_BODY.replace("A test skill", "An updated test skill");

  const result = gatePatch(vault, {
    execId: "ex-patch-001",
    name: "test-skill",
    oldBody,
    newBody,
  });

  expect(result.status).toBe("parked");
  const pending = listPendingDecisions(vault);
  const dec = pending.find((d) => d.id === result.decisionId)!;
  expect(dec.question).toContain("patch");
  expect(dec.question).toContain("test-skill");

  const staged = stagedSkillPath(vault, result.txnId, "test-skill");
  expect(readFileSync(staged, "utf8")).toContain("An updated test skill");
});

test("gateEdit stages full rewrite + parks an edit Decision", () => {
  const vault = tmpVault();
  const newBody = `---\nname: test-skill\ndescription: Complete rewrite\n---\n\n## Instructions\n\nNew content.\n`;

  const result = gateEdit(vault, {
    execId: "ex-edit-001",
    name: "test-skill",
    body: newBody,
  });

  expect(result.status).toBe("parked");
  const dec = listPendingDecisions(vault).find((d) => d.id === result.decisionId)!;
  expect(dec.question).toContain("edit");
  expect(dec.context).toContain("rewrite");
});

// ---------------------------------------------------------------------------
// Phase 1D: reject path — dropTxn
// ---------------------------------------------------------------------------

test("dropTxn cleans quarantine + audit-logs the rejection; catalog untouched", () => {
  const vault = tmpVault();
  const db = tmpDb();

  const result = gateCreate(vault, {
    execId: "ex-reject-001",
    name: "test-skill",
    body: GOOD_SKILL_BODY,
  });

  // Before drop: quarantine exists
  const qDir = join(quarantineDir(vault), result.txnId);
  expect(existsSync(qDir)).toBe(true);

  dropTxn(vault, result.txnId);

  // After drop: quarantine cleaned
  expect(existsSync(qDir)).toBe(false);

  // Live skill NOT created
  expect(existsSync(vaultSkillPath(vault, "test-skill"))).toBe(false);

  // Audit line written (reject)
  const auditLines = readFileSync(auditLogPath(vault), "utf8").trim().split("\n");
  const entry = JSON.parse(auditLines[0]);
  expect(entry.action).toContain("reject");
  expect(entry.name).toBe("test-skill");
});

// ---------------------------------------------------------------------------
// Phase 1E: gateDelete + applyApprovedTxn
// ---------------------------------------------------------------------------

test("gateDelete parks a delete Decision; applyApprovedTxn removes the live skill", () => {
  const vault = tmpVault();
  const db = tmpDb();

  // First install a skill
  const createResult = gateCreate(vault, {
    execId: "ex-del-create",
    name: "to-delete",
    body: GOOD_SKILL_BODY.replace("test-skill", "to-delete"),
  });
  activateStaged(vault, createResult.txnId, db);
  expect(existsSync(vaultSkillPath(vault, "to-delete"))).toBe(true);

  // Gate a delete
  const delResult = gateDelete(vault, {
    execId: "ex-del-gate",
    name: "to-delete",
  });
  expect(delResult.status).toBe("parked");

  // Apply the delete
  const applyResult = applyApprovedTxn(vault, delResult.txnId, db);
  expect((applyResult as { deleted: boolean }).deleted).toBe(true);
  expect(existsSync(vaultSkillPath(vault, "to-delete"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Phase 1F: rollback via revertSkill
// ---------------------------------------------------------------------------

test("revertSkill restores prior body from manifest baseline + appends audit revert line", () => {
  const vault = tmpVault();
  const db = tmpDb();

  // Install original skill
  const createResult = gateCreate(vault, {
    execId: "ex-revert-001",
    name: "revert-skill",
    body: GOOD_SKILL_BODY.replace("test-skill", "revert-skill"),
  });
  activateStaged(vault, createResult.txnId, db);

  // Write manifest (baseline)
  writeManifest(vault);

  // Modify the skill (simulate edit)
  const editResult = gateEdit(vault, {
    execId: "ex-revert-002",
    name: "revert-skill",
    body: `---\nname: revert-skill\ndescription: Modified\nversion: 2.0.0\n---\n\n## Instructions\n\nModified.\n`,
  });
  activateStaged(vault, editResult.txnId, db);

  // Verify modification is live
  const modifiedBody = readFileSync(vaultSkillPath(vault, "revert-skill"), "utf8");
  expect(modifiedBody).toContain("Modified");

  // Revert
  revertSkill(vault, "revert-skill", db);

  // Restored
  const restoredBody = readFileSync(vaultSkillPath(vault, "revert-skill"), "utf8");
  expect(restoredBody).toContain("revert-skill");
  expect(restoredBody).not.toContain("Modified");

  // Audit log should contain a revert entry
  const auditLines = readFileSync(auditLogPath(vault), "utf8").trim().split("\n");
  const revertEntry = auditLines.map((l) => JSON.parse(l)).find((e) => e.action === "revert");
  expect(revertEntry).toBeDefined();
  expect(revertEntry.name).toBe("revert-skill");
});

// ---------------------------------------------------------------------------
// Phase 1G: read-only surface
// ---------------------------------------------------------------------------

test("listVaultSkills returns sorted list of installed skills", () => {
  const vault = tmpVault();
  const db = tmpDb();

  for (const name of ["bravo-skill", "alpha-skill"]) {
    const body = GOOD_SKILL_BODY.replace("test-skill", name);
    const result = gateCreate(vault, { execId: `ex-list-${name}`, name, body });
    activateStaged(vault, result.txnId, db);
  }

  const skills = listVaultSkills(vault);
  expect(skills.length).toBe(2);
  expect(skills[0].name).toBe("alpha-skill");
  expect(skills[1].name).toBe("bravo-skill");
});

test("viewVaultSkill returns SKILL.md body for installed skill, null for absent", () => {
  const vault = tmpVault();
  const db = tmpDb();
  const result = gateCreate(vault, {
    execId: "ex-view-001",
    name: "test-skill",
    body: GOOD_SKILL_BODY,
  });
  activateStaged(vault, result.txnId, db);

  const body = viewVaultSkill(vault, "test-skill");
  expect(body).not.toBeNull();
  expect(body!).toContain("test-skill");

  expect(viewVaultSkill(vault, "non-existent")).toBeNull();
});

// ---------------------------------------------------------------------------
// Phase 1H: gateWriteFile
// ---------------------------------------------------------------------------

test("gateWriteFile stages file + parks Decision; apply puts it in skill dir", () => {
  const vault = tmpVault();
  const db = tmpDb();

  const result = gateWriteFile(vault, {
    execId: "ex-wf-001",
    name: "test-skill",
    filePath: "examples/example.md",
    content: "# Example\n\nThis is an example.",
  });

  expect(result.status).toBe("parked");
  const dec = listPendingDecisions(vault).find((d) => d.id === result.decisionId)!;
  expect(dec.question).toContain("write_file");

  applyApprovedTxn(vault, result.txnId, db);

  const destPath = join(vault, ".claude", "skills", "test-skill", "examples", "example.md");
  expect(existsSync(destPath)).toBe(true);
  expect(readFileSync(destPath, "utf8")).toContain("Example");
});

// ---------------------------------------------------------------------------
// Phase 1I: manifest read/write
// ---------------------------------------------------------------------------

test("writeManifest + readManifest round-trip preserves skill bodies", () => {
  const vault = tmpVault();
  const db = tmpDb();

  const result = gateCreate(vault, { execId: "ex-mfst-001", name: "test-skill", body: GOOD_SKILL_BODY });
  activateStaged(vault, result.txnId, db);

  writeManifest(vault);
  const manifest = readManifest(vault);
  expect(manifest.length).toBe(1);
  expect(manifest[0].name).toBe("test-skill");
  expect(manifest[0].body).toContain("test-skill");
});

// ---------------------------------------------------------------------------
// VOS-233: SYSTEM_PRIMITIVE_SKILLS filter — listVaultSkillsForDisplay
// ---------------------------------------------------------------------------

/** Plant a skill directly on disk (simulates init seeding, not the gate flow). */
function seedSkillDirect(vault: string, name: string): void {
  const dir = join(vault, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\nversion: 1.0.0\n---\n\n## Instructions\n\nSystem primitive.\n`,
  );
}

test("SYSTEM_PRIMITIVE_SKILLS contains skill-author and skill-manage-apply", () => {
  expect(SYSTEM_PRIMITIVE_SKILLS.has("skill-author")).toBe(true);
  expect(SYSTEM_PRIMITIVE_SKILLS.has("skill-manage-apply")).toBe(true);
  expect(SYSTEM_PRIMITIVE_SKILLS.size).toBe(2);
});

test("listVaultSkillsForDisplay excludes primitives, includes user skills", () => {
  const vault = tmpVault();
  const db = tmpDb();

  // Seed system primitives directly (as init would)
  for (const name of SYSTEM_PRIMITIVE_SKILLS) {
    seedSkillDirect(vault, name);
  }

  // Seed onboarding directly (as init would)
  seedSkillDirect(vault, "onboarding");

  // Add a user skill via the gate/activate flow
  const result = gateCreate(vault, {
    execId: "ex-vos233-user",
    name: "my-user-skill",
    body: GOOD_SKILL_BODY.replace("test-skill", "my-user-skill"),
  });
  activateStaged(vault, result.txnId, db);

  const displayList = listVaultSkillsForDisplay(vault);
  const displayNames = displayList.map((s) => s.name);

  // Primitives must NOT appear
  expect(displayNames).not.toContain("skill-author");
  expect(displayNames).not.toContain("skill-manage-apply");

  // User/catalog skills MUST appear
  expect(displayNames).toContain("onboarding");
  expect(displayNames).toContain("my-user-skill");
});

test("listVaultSkills (MCP path) still returns all skills including primitives", () => {
  const vault = tmpVault();
  const db = tmpDb();

  for (const name of SYSTEM_PRIMITIVE_SKILLS) {
    seedSkillDirect(vault, name);
  }
  seedSkillDirect(vault, "onboarding");

  const result = gateCreate(vault, {
    execId: "ex-vos233-mcp",
    name: "another-skill",
    body: GOOD_SKILL_BODY.replace("test-skill", "another-skill"),
  });
  activateStaged(vault, result.txnId, db);

  const allNames = listVaultSkills(vault).map((s) => s.name);

  // All four skills must be present (primitives are NOT filtered from listVaultSkills)
  expect(allNames).toContain("skill-author");
  expect(allNames).toContain("skill-manage-apply");
  expect(allNames).toContain("onboarding");
  expect(allNames).toContain("another-skill");
});
