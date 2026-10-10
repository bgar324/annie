import { describe, expect, it } from "vitest";
import { ModelSafeError } from "../src/core/errors.js";
import { planTaskEdit, projectTasks, type TaskPlan, type TaskProjection, type TaskSection } from "../src/notion/tasks.js";

const binding = JSON.stringify({ runId: "run_one", connectionId: "private_connection", credentialGeneration: 1, pageId: "page_one" });

function lastSection(view: TaskProjection): TaskSection {
  const section = view.sections.at(-1);
  if (section === undefined) throw new Error("Fixture must expose a section");
  return section;
}

function taskRef(section: TaskSection, index = 0): string {
  const task = section.tasks[index];
  if (task === undefined) throw new Error("Fixture must expose a task");
  return task.ref;
}

function changed(plan: TaskPlan): Extract<TaskPlan, { outcome: "changed" }> {
  if (plan.outcome !== "changed") throw new Error("Fixture must change source");
  return plan;
}

function applyPatch(source: string, plan: Extract<TaskPlan, { outcome: "changed" }>): string {
  const offset = source.indexOf(plan.oldText);
  expect(offset).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(plan.oldText, offset + 1)).toBe(-1);
  return source.slice(0, offset) + plan.newText + source.slice(offset + plan.oldText.length);
}

describe("compact Notion task views", () => {
  it("shows document-tail direct sections with hierarchy, not sorted dates", () => {
    const source = ["# Tasks", "## 2026-10-09", "### Ben's To-do's:", "- [ ] Same",
      "## 2026-10-08", "### Ben's To-do's:", "- [x] Same"].join("\n");
    const view = projectTasks(source, binding);
    expect(view.available).toBe(true);
    expect(view.ordering).toBe("document_tail");
    expect(view.sections.map((section) => section.path)).toEqual([
      ["Tasks", "2026-10-09", "Ben's To-do's:"],
      ["Tasks", "2026-10-08", "Ben's To-do's:"],
    ]);
    expect(view.totalSections).toBe(2);
    expect(view.omittedSections).toBe(0);
    expect(view.sections.flatMap((section) => section.tasks.map((task) => task.checked))).toEqual([false, true]);
  });

  it("keeps parent tasks and empty leaves editable without offering empty container targets", () => {
    const source = "# Tasks\n- [ ] Shared\n## Day\n### Sam\n- [ ] Sam task\n### Ben\n";
    const view = projectTasks(source, binding);
    expect(view.sections.map((section) => section.path)).toEqual([
      ["Tasks"], ["Tasks", "Day", "Sam"], ["Tasks", "Day", "Ben"],
    ]);
    const ben = lastSection(view);
    const plan = changed(planTaskEdit(source, binding, [{ kind: "append", section: ben.ref, text: "Ben task" }]));
    expect(plan.appliedText).toBe(`${source}- [ ] Ben task\n`);
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
  });

  it("bounds section and task counts while reporting omissions", () => {
    const source = Array.from({ length: 6 }, (_, section) => `## Day ${section}\n`
      + Array.from({ length: 20 }, (_, task) => `- [ ] Task ${task}`).join("\n")).join("\n");
    const view = projectTasks(source, binding);
    expect(view.sections.map((section) => section.path)).toEqual([["Day 3"], ["Day 4"], ["Day 5"]]);
    expect(view.totalSections).toBe(6);
    expect(view.omittedSections).toBe(3);
    for (const section of view.sections) {
      expect(section.tasks).toHaveLength(12);
      expect(section.tasks[0]?.text).toBe("Task 8");
      expect(section.omittedTasks).toBe(8);
    }
  });

  it("caps UTF8 bytes without truncating task text or lying about omitted tasks", () => {
    const label = "漢".repeat(1_000);
    const source = "# Tasks\n" + Array.from({ length: 12 }, () => `- [ ] ${label}`).join("\n");
    const view = projectTasks(source, binding);
    expect(Buffer.byteLength(JSON.stringify(view), "utf8")).toBeLessThanOrEqual(6 * 1_024);
    const section = lastSection(view);
    expect(section.tasks.length).toBeGreaterThan(0);
    expect(section.tasks.length + section.omittedTasks).toBe(12);
    expect(section.tasks.every((task) => task.text === label)).toBe(true);
  });

  it("omits an oversized heading rather than exposing an oversized view", () => {
    const view = projectTasks(`# ${"漢".repeat(3_000)}\n- [ ] Task`, binding);
    expect(view.available).toBe(true);
    expect(view.sections).toEqual([]);
    expect(view.omittedSections).toBe(1);
    expect(view.totalSections).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(6 * 1_024);
  });

  it("finds older paths and task labels with literal case-insensitive matching", () => {
    const source = ["# Older [day]", "- [ ] Dollar $& task", "# Middle", "- [ ] Middle",
      "# Later", "- [ ] Later", "# Last", "- [ ] Last"].join("\n");
    expect(projectTasks(source, binding).sections.some((section) => section.path[0] === "Older [day]")).toBe(false);
    const byPath = projectTasks(source, binding, { match: "OLDER [DAY]" });
    expect(byPath.sections.map((section) => section.path)).toEqual([["Older [day]"]]);
    expect(byPath.ordering).toBe("matched_document_tail");
    expect(byPath.omittedSections).toBe(3);
    expect(projectTasks(source, binding, { match: "DOLLAR $&" }).sections).toEqual(byPath.sections);
    expect(projectTasks(source, binding, { match: ".*" }).sections).toEqual([]);
  });

  it("exposes an early task match beyond the normal section task tail", () => {
    const source = "# Tasks\n- [ ] Early target\n"
      + Array.from({ length: 19 }, (_, index) => `- [ ] Other ${index}`).join("\n");
    expect(lastSection(projectTasks(source, binding)).tasks.some((task) => task.text === "Early target")).toBe(false);
    const matched = lastSection(projectTasks(source, binding, { match: "EARLY TARGET" }));
    expect(matched.tasks.map((task) => task.text)).toEqual(["Early target"]);
    expect(matched.omittedTasks).toBe(19);
    const plan = changed(planTaskEdit(source, binding, [{ kind: "check", task: taskRef(matched), checked: true }]));
    expect(plan.appliedText).toBe(source.replace("- [ ] Early target", "- [x] Early target"));
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
    const headingMatch = lastSection(projectTasks(source, binding, { match: "TASKS" }));
    expect(headingMatch.tasks.map((task) => task.text))
      .toEqual(lastSection(projectTasks(source, binding)).tasks.map((task) => task.text));
    expect(headingMatch.omittedTasks).toBe(8);
  });

  it("exposes root tasks and empty headings, not unrelated prose sections", () => {
    const view = projectTasks("- [ ] Root\n# Prose\nOrdinary prose\n# Empty\n\n---\n<empty-block/>\n", binding);
    expect(view.sections.map((section) => section.path)).toEqual([[], ["Empty"]]);
    expect(view.sections[0]?.tasks.map((task) => task.text)).toEqual(["Root"]);
    expect(view.sections[1]?.tasks).toEqual([]);
  });

  it("confines tasks to content while ignoring fenced headings, tasks and wrapper text", () => {
    const source = ["<page url=\"https://notion.so/private\">", "# Metadata", "- [ ] Metadata",
      "<content>", "# Real", "```xml", "# Fake", "- [ ] Fake", "</content>", "```",
      "~~~", "- [x] Fake too", "~~~", "\t*\t[X]\tReal task  ", "</content>", "</page>"].join("\r\n");
    const view = projectTasks(source, binding);
    expect(view.sections.map((section) => section.path)).toEqual([["Real"]]);
    expect(lastSection(view).tasks.map((task) => ({ text: task.text, checked: task.checked })))
      .toEqual([{ text: "Real task", checked: true }]);
  });

  it("supports a page envelope without a content envelope", () => {
    const view = projectTasks("<page>\n# Tasks\n- [ ] A\n</page>", binding);
    expect(lastSection(view).tasks.map((task) => task.text)).toEqual(["A"]);
  });

  it("ignores closed callout containers and keeps production-style tail sections editable", () => {
    const source = ["<page>", "<ancestor-path>Parent metadata</ancestor-path>", "<properties>",
      "# Metadata", "- [ ] Not a task", "</properties>", "<iconMetadata>icon</iconMetadata>", "<content>",
      "<callout icon=\"💡\">", "### Callout heading", "- [ ] Ignored", "</callout>",
      "## 2026-10-09", "### Ben's To-do's:", "- [ ] Same", "### Jadyn's To-do's:",
      "- [ ] Same", "---", "<empty-block/>", "</content>", "</page>"].join("\n");
    const view = projectTasks(source, binding);
    expect(view.available).toBe(true);
    expect(view.sections.flatMap((section) => section.tasks.map((task) => task.text))).toEqual(["Same", "Same"]);
    expect(view.sections.some((section) => section.path.includes("Callout heading"))).toBe(false);
    const section = lastSection(view);
    const plan = changed(planTaskEdit(source, binding, [{ kind: "append", section: section.ref, text: "New" }]));
    expect(plan.appliedText).toBe(source.replace("- [ ] Same\n---", "- [ ] Same\n- [ ] New\n---"));
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
  });

  it("uses the actual remaining metadata byte budget for complete and unavailable projections", () => {
    const source = "# Tasks\n" + Array.from({ length: 12 }, (_, index) => `- [ ] Task ${index}`).join("\n");
    const view = projectTasks(source, binding, { maxBytes: 500 });
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(500);
    expect(lastSection(view).tasks.length).toBeGreaterThan(0);
    expect(lastSection(view).omittedTasks).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(projectTasks(source, binding, { maxBytes: 100_000 }))))
      .toBeLessThanOrEqual(6 * 1_024);
    for (const maxBytes of [0, -1, 1, 100, Number.NaN]) {
      expect(() => projectTasks(source, binding, { maxBytes })).toThrow(ModelSafeError);
      expect(() => projectTasks("<content>\n# Tasks", binding, { maxBytes })).toThrow(ModelSafeError);
    }
  });

  it.each([
    "# Tasks\n```\n- [ ] Hidden", "# Tasks\n~~~\n- [ ] Hidden",
    "<content>\n# Tasks\n- [ ] A", "<page>\n<content>\n# Tasks\n</page>\n</content>",
    "<content>\n# Tasks\n</content>\n<content>\n- [ ] A\n</content>",
    "<content># Tasks\n- [ ] A\n</content>", "<content>\n<page>\n- [ ] A\n</page>\n</content>",
  ])("does not issue handles for unsupported structure %#", (source) => {
    const view = projectTasks(source, binding);
    expect(view.available).toBe(false);
    expect(view.reason).toBeTruthy();
    expect(view.sections).toEqual([]);
    expect(() => planTaskEdit(source, binding, [{ kind: "append", section: "forged", text: "A" }]))
      .toThrow(ModelSafeError);
  });
});

describe("source-scoped task planning", () => {
  it("gives repeated labels separate deterministic targets without exposing binding", () => {
    const source = "## Same\n- [ ] Same\n## Same\n- [ ] Same";
    const view = projectTasks(source, binding);
    const first = view.sections[0];
    const second = view.sections[1];
    if (first === undefined || second === undefined) throw new Error("Missing fixture sections");
    expect(first.ref).not.toBe(second.ref);
    expect(taskRef(first)).not.toBe(taskRef(second));
    expect(projectTasks(source, binding)).toEqual(view);
    expect(JSON.stringify(view)).not.toContain("private_connection");
    const plan = changed(planTaskEdit(source, binding, [{ kind: "check", task: taskRef(second), checked: true }]));
    expect(plan.appliedText).toBe("## Same\n- [ ] Same\n## Same\n- [x] Same");
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
  });

  it("preserves every unrelated byte through batched checks and ordered appends", () => {
    const source = "<page>\r\n<content>\r\n# Tasks\r\n## Ben\r\n\t*\t[ ]\tOne  \r\n"
      + "\t*\t[x]\tTwo\t\r\n\r\n---\r\n## Jadyn\r\n- [ ] Other\r\n</content>\r\n</page>";
    const view = projectTasks(source, binding);
    const ben = view.sections.find((section) => section.path.at(-1) === "Ben");
    const jadyn = view.sections.find((section) => section.path.at(-1) === "Jadyn");
    if (ben === undefined || jadyn === undefined) throw new Error("Missing fixture sections");
    const dollarText = "Literal $& $' $` $1 $$";
    const plan = changed(planTaskEdit(source, binding, [
      { kind: "check", task: taskRef(ben), checked: true },
      { kind: "append", section: ben.ref, text: dollarText },
      { kind: "check", task: taskRef(jadyn), checked: true },
      { kind: "append", section: ben.ref, text: "Second" },
      { kind: "check", task: taskRef(ben, 1), checked: false },
    ]));
    const expected = "<page>\r\n<content>\r\n# Tasks\r\n## Ben\r\n\t*\t[x]\tOne  \r\n"
      + `\t*\t[ ]\tTwo\t\r\n\t*\t[ ] ${dollarText}\r\n\t*\t[ ] Second\r\n`
      + "\r\n---\r\n## Jadyn\r\n- [x] Other\r\n</content>\r\n</page>";
    expect(plan.appliedText).toBe(expected);
    expect(applyPatch(source, plan)).toBe(expected);
    expect(plan.view.ordering).toBe("changed_sections");
    expect(plan.view.sections.map((section) => section.path.at(-1))).toEqual(["Ben", "Jadyn"]);
  });

  it.each([
    { source: "- [ ] Old", expected: "- [ ] Old\n- [ ] New" },
    { source: "- [ ] Old\n", expected: "- [ ] Old\n- [ ] New\n" },
    { source: "# Empty", expected: "# Empty\n- [ ] New" },
    { source: "# Empty\r\n", expected: "# Empty\r\n- [ ] New\r\n" },
    { source: "# Empty\n\n---\n<empty-block/>\n", expected: "# Empty\n- [ ] New\n\n---\n<empty-block/>\n" },
    { source: "<content>\n# Empty\n</content>", expected: "<content>\n# Empty\n- [ ] New\n</content>" },
    { source: "# Tasks\n- [ ] Old\n```\n- [ ] Code\n```\n", expected: "# Tasks\n- [ ] Old\n```\n- [ ] Code\n```\n- [ ] New\n" },
  ])("appends at a source-backed boundary %#", ({ source, expected }) => {
    const section = lastSection(projectTasks(source, binding));
    const plan = changed(planTaskEdit(source, binding, [{ kind: "append", section: section.ref, text: "New" }]));
    expect(plan.appliedText).toBe(expected);
    expect(applyPatch(source, plan)).toBe(expected);
  });

  it.each([
    { body: "- [ ] Root\r\n  + [ ] Child", prefix: "- " },
    { body: "  + [ ] Root\r\n\t* [ ] Child", prefix: "  + " },
    { body: "   * [ ] Root\r\n \t+ [ ] Child", prefix: "   * " },
    { body: "\t+ [ ] Root\r\n    * [ ] Same-depth peer\r\n\t\t- [ ] Child", prefix: "\t+ " },
  ])("appends a shallowest-list peer, not a nested last-task child %#", ({ body, prefix }) => {
    const source = `# Tasks\r\n${body}`;
    const section = lastSection(projectTasks(source, binding));
    const plan = changed(planTaskEdit(source, binding, [{ kind: "append", section: section.ref, text: "New peer" }]));
    expect(plan.appliedText).toBe(`${source}\r\n${prefix}[ ] New peer`);
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
    expect(lastSection(plan.view).tasks.at(-1)?.text).toBe("New peer");
  });

  it("never deduplicates explicitly requested appends", () => {
    const source = "# Tasks\n- [ ] Same";
    const section = lastSection(projectTasks(source, binding));
    const plan = changed(planTaskEdit(source, binding, [
      { kind: "append", section: section.ref, text: "Same" },
      { kind: "append", section: section.ref, text: "Same" },
    ]));
    expect(plan.appliedText).toBe("# Tasks\n- [ ] Same\n- [ ] Same\n- [ ] Same");
    expect(new Set(lastSection(plan.view).tasks.map((task) => task.ref)).size).toBe(3);
  });

  it("returns unchanged without rewriting an already satisfied uppercase checkbox", () => {
    const source = "# Tasks\r\n\t- [X] Same  ";
    const view = projectTasks(source, binding);
    const plan = planTaskEdit(source, binding, [{ kind: "check", task: taskRef(lastSection(view)), checked: true }]);
    expect(plan.outcome).toBe("unchanged");
    expect(plan.view).toEqual(view);
  });

  it("refreshes all source-bound refs and supports a subsequent edit from the returned changed view", () => {
    const source = "# Tasks\n- [ ] Old";
    const original = lastSection(projectTasks(source, binding));
    const first = changed(planTaskEdit(source, binding, [{ kind: "append", section: original.ref, text: "New" }]));
    const refreshed = lastSection(first.view);
    expect(refreshed.ref).not.toBe(original.ref);
    expect(taskRef(refreshed)).not.toBe(taskRef(original));
    expect(first.view.sections).toEqual(projectTasks(first.appliedText, binding).sections);
    const next = changed(planTaskEdit(first.appliedText, binding, [{ kind: "check", task: taskRef(refreshed, 1), checked: true }]));
    expect(next.appliedText).toBe("# Tasks\n- [ ] Old\n- [x] New");
    expect(() => planTaskEdit(first.appliedText, binding, [{ kind: "check", task: taskRef(original), checked: true }]))
      .toThrow(expect.objectContaining({ code: "task_ref_invalid" }));
  });

  it("rejects stale, forged, wrong-kind and cross-binding refs instead of resolving by label", () => {
    const source = "# Tasks\n- [ ] Same";
    const section = lastSection(projectTasks(source, binding));
    const staleTask = taskRef(section);
    for (const otherBinding of ["other-run", "other-page", "other-connection", "other-generation"]) {
      expect(() => planTaskEdit(source, otherBinding, [{ kind: "check", task: staleTask, checked: true }]))
        .toThrow(expect.objectContaining({ code: "task_ref_invalid" }));
    }
    for (const task of ["forged", section.ref, "", staleTask.slice(0, -1)]) {
      expect(() => planTaskEdit(source, binding, [{ kind: "check", task, checked: true }]))
        .toThrow(expect.objectContaining({ code: "task_ref_invalid" }));
    }
    expect(() => planTaskEdit(source + "\n", binding, [{ kind: "check", task: staleTask, checked: true }]))
      .toThrow(expect.objectContaining({ code: "task_ref_invalid" }));
    expect(() => planTaskEdit(source, binding, [{ kind: "append", section: staleTask, text: "A" }]))
      .toThrow(expect.objectContaining({ code: "task_ref_invalid" }));
  });

  it("rejects duplicate task changes even if individually unchanged or contradictory", () => {
    const source = "# Tasks\n- [ ] Same";
    const task = taskRef(lastSection(projectTasks(source, binding)));
    for (const checked of [true, false]) {
      expect(() => planTaskEdit(source, binding, [{ kind: "check", task, checked: false }, { kind: "check", task, checked }]))
        .toThrow(expect.objectContaining({ code: "task_change_invalid" }));
    }
  });

  it.each(["", "  \t", "first\nsecond", "first\rsecond", "first\u2028second", "x".repeat(2_001)])(
    "rejects task text outside the single-line limit %#", (text) => {
      const source = "# Empty";
      const section = lastSection(projectTasks(source, binding));
      expect(() => planTaskEdit(source, binding, [{ kind: "append", section: section.ref, text }]))
        .toThrow(expect.objectContaining({ code: "task_change_invalid" }));
    },
  );

  it("accepts maximum task length but rejects oversized batches and generated patches", () => {
    const source = "# Empty";
    const section = lastSection(projectTasks(source, binding));
    const task = "x".repeat(2_000);
    expect(changed(planTaskEdit(source, binding, [{ kind: "append", section: section.ref, text: task }])).appliedText)
      .toBe(`# Empty\n- [ ] ${task}`);
    expect(() => planTaskEdit(source, binding, [])).toThrow(expect.objectContaining({ code: "task_change_invalid" }));
    expect(() => planTaskEdit(source, binding, Array.from({ length: 17 }, () => ({ kind: "append", section: section.ref, text: "A" }))))
      .toThrow(expect.objectContaining({ code: "task_change_invalid" }));
    expect(() => planTaskEdit(source, binding, Array.from({ length: 4 }, () => ({ kind: "append", section: section.ref, text: task }))))
      .toThrow(expect.objectContaining({ code: "task_patch_too_large" }));
  });

  it("rejects a batch whose changed positions cannot fit one bounded source span", () => {
    const source = "# First\n- [ ] First\n" + "prose\n".repeat(1_500) + "# Last\n- [ ] Last";
    const sections = projectTasks(source, binding).sections;
    const first = sections[0];
    const last = sections.at(-1);
    if (first === undefined || last === undefined) throw new Error("Missing fixture sections");
    expect(() => planTaskEdit(source, binding, [
      { kind: "check", task: taskRef(first), checked: true }, { kind: "check", task: taskRef(last), checked: true },
    ])).toThrow(expect.objectContaining({ code: "task_patch_too_large" }));
  });

  it("requires unique complete-line anchors even when repeated task text is identical", () => {
    const source = "# First\n- [ ] Same\n# Second\n- [ ] Same\n";
    const section = lastSection(projectTasks(source, binding));
    const plan = changed(planTaskEdit(source, binding, [{ kind: "check", task: taskRef(section), checked: true }]));
    expect(plan.appliedText).toBe("# First\n- [ ] Same\n# Second\n- [x] Same\n");
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
    expect(plan.oldText.length).toBeLessThanOrEqual(8_000);
    expect(plan.newText.length).toBeLessThanOrEqual(8_000);
  });

  it("does not accept anchors with overlapping repeated-line matches", () => {
    const source = "# Tasks\n- [ ] Same\n- [ ] Same\n- [ ] Same\n";
    const section = lastSection(projectTasks(source, binding));
    const plan = changed(planTaskEdit(source, binding, [{ kind: "check", task: taskRef(section, 1), checked: true }]));
    expect(plan.appliedText).toBe("# Tasks\n- [ ] Same\n- [x] Same\n- [ ] Same\n");
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
  });

  it("rejects an oversized whole-line anchor even when the task label is small", () => {
    const source = "# Tasks\n" + " ".repeat(8_001) + "- [ ] Same";
    const section = lastSection(projectTasks(source, binding));
    expect(() => planTaskEdit(source, binding, [{ kind: "check", task: taskRef(section), checked: true }]))
      .toThrow(expect.objectContaining({ code: "task_patch_too_large" }));
  });

  it("preserves UTF16 offsets and treats wrapper-looking task text literally", () => {
    const source = "# Tasks 😃\r\n- [ ] Emoji 🧪 first  \r\n- [ ] Mention <page> and <content>";
    const section = lastSection(projectTasks(source, binding));
    const plan = changed(planTaskEdit(source, binding, [
      { kind: "check", task: taskRef(section, 1), checked: true },
      { kind: "append", section: section.ref, text: "Write <content> literally $&" },
    ]));
    expect(plan.appliedText).toBe("# Tasks 😃\r\n- [ ] Emoji 🧪 first  \r\n- [x] Mention <page> and <content>\r\n- [ ] Write <content> literally $&");
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
  });

  it("uses an available right-hand anchor when a left neighbor cannot fit", () => {
    const source = "x".repeat(8_100) + "\n- [ ] Same\nunique right neighbor\n# Other\n- [ ] Same\n";
    const root = projectTasks(source, binding).sections[0];
    if (root === undefined) throw new Error("Missing root fixture section");
    const plan = changed(planTaskEdit(source, binding, [{ kind: "check", task: taskRef(root), checked: true }]));
    expect(plan.appliedText).toBe(source.replace("- [ ] Same", "- [x] Same"));
    expect(applyPatch(source, plan)).toBe(plan.appliedText);
    expect(plan.oldText.length).toBeLessThanOrEqual(8_000);
  });

  it("bounds refreshed changed and unchanged views using the write envelope budget", () => {
    const source = "# Tasks\n" + Array.from({ length: 12 }, (_, index) => `- [ ] Task ${index}`).join("\n");
    const section = lastSection(projectTasks(source, binding));
    const plan = changed(planTaskEdit(source, binding, [{ kind: "append", section: section.ref, text: "New" }], { maxViewBytes: 500 }));
    expect(Buffer.byteLength(JSON.stringify(plan.view))).toBeLessThanOrEqual(500);
    expect(lastSection(plan.view).tasks.at(-1)?.text).toBe("New");
    const noop = planTaskEdit(source, binding, [{ kind: "check", task: taskRef(section), checked: false }], { maxViewBytes: 500 });
    expect(noop.outcome).toBe("unchanged");
    expect(Buffer.byteLength(JSON.stringify(noop.view))).toBeLessThanOrEqual(500);
    expect(() => planTaskEdit(source, binding, [{ kind: "append", section: section.ref, text: "New" }], { maxViewBytes: 1 }))
      .toThrow(expect.objectContaining({ code: "task_view_too_large" }));
  });

  it("allows an older matched task reference to edit its exact section", () => {
    const source = ["# Old", "- [ ] Old", "# Two", "- [ ] Two", "# Three", "- [ ] Three", "# Four", "- [ ] Four"].join("\n");
    const old = lastSection(projectTasks(source, binding, { match: "Old" }));
    const plan = changed(planTaskEdit(source, binding, [{ kind: "check", task: taskRef(old), checked: true }]));
    expect(plan.appliedText).toBe(source.replace("- [ ] Old", "- [x] Old"));
    expect(plan.view.sections.map((section) => section.path)).toEqual([["Old"]]);
  });
});
