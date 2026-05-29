import { expect, test } from "bun:test";
import { parseFrontmatter } from "../src/frontmatter.ts";

test("extracts name and description from front matter", () => {
  const md = `---\nname: deep-research\ndescription: Fan-out research harness.\n---\n# body`;
  expect(parseFrontmatter(md)).toEqual({ name: "deep-research", description: "Fan-out research harness." });
});

test("missing front matter returns empty fields", () => {
  expect(parseFrontmatter("# no front matter")).toEqual({ name: "", description: "" });
});

test("handles quoted values", () => {
  const md = `---\nname: "my-skill"\ndescription: 'Single quoted.'\n---\n`;
  const r = parseFrontmatter(md);
  expect(r.name).toBe("my-skill");
  expect(r.description).toBe("Single quoted.");
});

test("ignores unknown keys", () => {
  const md = `---\nname: test\nauthor: Alice\ndescription: Hello.\n---\n`;
  expect(parseFrontmatter(md)).toEqual({ name: "test", description: "Hello." });
});
