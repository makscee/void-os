import { expect, test } from "bun:test";
import { parseFrontmatter } from "../src/frontmatter.ts";

test("extracts name and description from front matter", () => {
  const md = `---\nname: deep-research\ndescription: Fan-out research harness.\n---\n# body`;
  const r = parseFrontmatter(md);
  expect(r.name).toBe("deep-research");
  expect(r.description).toBe("Fan-out research harness.");
});

test("missing front matter returns empty fields", () => {
  const r = parseFrontmatter("# no front matter");
  expect(r.name).toBe("");
  expect(r.description).toBe("");
  expect(r.needsInput).toBe(false);
});

test("handles quoted values", () => {
  const md = `---\nname: "my-skill"\ndescription: 'Single quoted.'\n---\n`;
  const r = parseFrontmatter(md);
  expect(r.name).toBe("my-skill");
  expect(r.description).toBe("Single quoted.");
});

test("ignores unknown keys", () => {
  const md = `---\nname: test\nauthor: Alice\ndescription: Hello.\n---\n`;
  const r = parseFrontmatter(md);
  expect(r.name).toBe("test");
  expect(r.description).toBe("Hello.");
});

test("parseFrontmatter reads needs_input + input_label", () => {
  const md = `---\nname: deep-research\ndescription: x\nneeds_input: true\ninput_label: "Research query"\n---\nbody`;
  const m = parseFrontmatter(md);
  expect(m.needsInput).toBe(true);
  expect(m.inputLabel).toBe("Research query");
});

test("parseFrontmatter defaults needsInput false when absent", () => {
  const m = parseFrontmatter("---\nname: x\ndescription: y\n---\n");
  expect(m.needsInput).toBe(false);
  expect(m.inputLabel).toBe("");
});

test("parses output_target when present", () => {
  const md = `---\nname: w\ndescription: d\noutput_target: reports/out.html\n---\n# body`;
  expect(parseFrontmatter(md).outputTarget).toBe("reports/out.html");
});

test("output_target defaults to empty string when absent", () => {
  const md = `---\nname: w\ndescription: d\n---\n# body`;
  expect(parseFrontmatter(md).outputTarget).toBe("");
});

test("parseFrontmatter reads interactive: true", () => {
  const md = `---\nname: chat\ndescription: d\ninteractive: true\n---\nbody`;
  expect(parseFrontmatter(md).interactive).toBe(true);
});
test("parseFrontmatter reads interactive: false", () => {
  const md = `---\nname: organize\ndescription: d\ninteractive: false\n---\nbody`;
  expect(parseFrontmatter(md).interactive).toBe(false);
});
test("parseFrontmatter leaves interactive undefined when absent", () => {
  const md = `---\nname: x\ndescription: d\n---\nbody`;
  expect(parseFrontmatter(md).interactive).toBeUndefined();
});
