import { createHash } from "node:crypto";
import { ModelSafeError } from "../core/errors.js";

export type TaskChange =
  | { kind: "append"; section: string; text: string }
  | { kind: "check"; task: string; checked: boolean };

export interface TaskSection {
  ref: string;
  path: readonly string[];
  tasks: readonly { ref: string; text: string; checked: boolean }[];
  omittedTasks: number;
}

export interface TaskProjection {
  view: "tasks";
  sourceComplete: true;
  available: boolean;
  reason?: string;
  sections: readonly TaskSection[];
  omittedSections: number;
  totalSections: number;
  ordering: "document_tail" | "matched_document_tail" | "changed_sections";
}

export type TaskPlan =
  | { outcome: "unchanged"; view: TaskProjection }
  | { outcome: "changed"; oldText: string; newText: string; appliedText: string; view: TaskProjection };

interface Line {
  start: number;
  end: number;
  body: string;
  newline: string;
  fenced: boolean;
}

interface Task {
  index: number;
  text: string;
  checked: boolean;
  marker: number;
  prefix: string;
}

interface Section {
  index: number;
  path: string[];
  startLine: number;
  endLine: number;
  tasks: Task[];
  empty: boolean;
}

type Scan =
  | { available: false; reason: string }
  | { available: true; lines: Line[]; sections: Section[] };

interface Splice {
  position: number;
  remove: number;
  value: string;
}

const MAX_PATCH = 8_000;
const MAX_VIEW_BYTES = 6 * 1_024;

export function projectTasks(text: string, binding: string, options: { match?: string; maxBytes?: number } = {}): TaskProjection {
  const maxBytes = viewCapacity(options.maxBytes);
  const scan = scanTasks(text);
  const ordering = options.match === undefined ? "document_tail" : "matched_document_tail";
  if (!scan.available) return unavailable(scan.reason, ordering, maxBytes);
  const needle = options.match?.toLowerCase();
  const candidates = scan.sections.filter((section) => needle === undefined
    || section.path.some((part) => part.toLowerCase().includes(needle))
    || section.tasks.some((task) => task.text.toLowerCase().includes(needle)));
  return projection(text, binding, scan.sections.length, candidates, ordering, maxBytes, needle);
}

export function planTaskEdit(text: string, binding: string, changes: readonly TaskChange[],
  options: { maxViewBytes?: number } = {}): TaskPlan {
  const maxBytes = viewCapacity(options.maxViewBytes);
  const scan = scanTasks(text);
  if (!scan.available) fail("task_view_unavailable", scan.reason);
  if (changes.length < 1 || changes.length > 16) {
    fail("task_change_invalid", "Supply between one and sixteen task changes.");
  }
  const refs = references(text, binding);
  const sectionByRef = new Map(scan.sections.map((section) => [refs("s", section.index), section]));
  const taskByRef = new Map<string, { section: Section; task: Task }>();
  for (const section of scan.sections) {
    for (const task of section.tasks) taskByRef.set(refs("t", task.index), { section, task });
  }
  const checkedRefs = new Set<string>();
  const additions = new Map<Section, string[]>();
  const changedSections = new Set<number>();
  const splices: Splice[] = [];
  for (const change of changes) {
    if (change.kind === "append") {
      const section = sectionByRef.get(change.section);
      if (section === undefined) invalidRef();
      if (change.text.length > 2_000 || change.text.trim().length === 0 || /[\r\n\u2028\u2029]/u.test(change.text)) {
        fail("task_change_invalid", "New task text must be one nonempty line of at most 2000 characters.");
      }
      const texts = additions.get(section) ?? [];
      texts.push(change.text);
      additions.set(section, texts);
      changedSections.add(section.index);
    } else {
      if (checkedRefs.has(change.task)) {
        fail("task_change_invalid", "A batch cannot change the same task more than once.");
      }
      checkedRefs.add(change.task);
      const target = taskByRef.get(change.task);
      if (target === undefined) invalidRef();
      if (target.task.checked !== change.checked) {
        splices.push({ position: target.task.marker, remove: 1, value: change.checked ? "x" : " " });
        changedSections.add(target.section.index);
      }
    }
  }
  for (const [section, texts] of additions) {
    splices.push(appendSplice(text, scan.lines, section, texts));
  }
  if (splices.length === 0) {
    return { outcome: "unchanged", view: projection(text, binding, scan.sections.length, scan.sections, "document_tail", maxBytes) };
  }
  splices.sort((a, b) => b.position - a.position);
  const patch = uniquePatch(text, scan.lines, splices);
  const appliedText = applySplices(text, splices, 0);
  const refreshed = scanTasks(appliedText);
  if (!refreshed.available) fail("task_view_unavailable", refreshed.reason);
  return {
    outcome: "changed",
    ...patch,
    appliedText,
    view: projection(appliedText, binding, refreshed.sections.length,
      refreshed.sections.filter((section) => changedSections.has(section.index)), "changed_sections", maxBytes),
  };
}

function scanTasks(text: string): Scan {
  const lines: Line[] = [];
  let offset = 0;
  while (offset < text.length) {
    const lf = text.indexOf("\n", offset);
    const end = lf === -1 ? text.length : lf + 1;
    const crlf = lf > offset && text[lf - 1] === "\r";
    lines.push({ start: offset, end, body: text.slice(offset, lf === -1 ? end : lf - (crlf ? 1 : 0)),
      newline: lf === -1 ? "" : crlf ? "\r\n" : "\n", fenced: false });
    offset = end;
  }
  let fence: { character: string; length: number } | undefined;
  let calloutDepth = 0;
  const envelopes: { name: string; line: number }[] = [];
  const bounds = new Map<string, { start: number; end: number }>();
  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line.body);
    if (fence !== undefined) {
      line.fenced = true;
      if (delimiter !== null && delimiter[1]?.[0] === fence.character
        && delimiter[1].length >= fence.length && delimiter[2]?.trim() === "") fence = undefined;
      continue;
    }
    if (delimiter !== null && delimiter[1] !== undefined) {
      if (delimiter[1][0] === "`" && delimiter[2]?.includes("`")) {
        return { available: false, reason: "Unsupported code fence delimiter." };
      }
      fence = { character: delimiter[1][0] ?? "`", length: delimiter[1].length };
      line.fenced = true;
      continue;
    }
    if (/^[ \t]*<callout\b[^<>]*>.*<\/callout>[ \t]*$/u.test(line.body)) {
      line.fenced = true;
      continue;
    }
    const callout = /^[ \t]*<(\/?)callout(?:[ \t]+[^<>]*?)?>[ \t]*$/u.exec(line.body);
    if (callout !== null) {
      calloutDepth += callout[1] === "/" ? -1 : 1;
      if (calloutDepth < 0) return { available: false, reason: "Malformed callout wrapper." };
      line.fenced = true;
      continue;
    }
    if (/^[ \t]*<\/?callout\b/u.test(line.body)) {
      return { available: false, reason: "Malformed callout wrapper." };
    }
    if (calloutDepth > 0) {
      line.fenced = true;
      continue;
    }
    const wrapper = /^[ \t]*<(\/?)(page|content)(?:[ \t]+[^<>]*?)?>[ \t]*$/u.exec(line.body);
    if (wrapper === null) {
      if (/^[ \t]*<\/?(?:page|content)\b/u.test(line.body)) {
        return { available: false, reason: "Content and page wrappers must be complete standalone lines." };
      }
      continue;
    }
    const name = wrapper[2] ?? "";
    if (wrapper[1] === "/") {
      const opened = envelopes.pop();
      if (opened?.name !== name || bounds.has(name)) {
        return { available: false, reason: "Malformed or repeated content/page wrappers." };
      }
      bounds.set(name, { start: opened.line + 1, end: index });
    } else {
      if (bounds.has(name) || envelopes.some((opened) => opened.name === name)
        || (name === "page" && envelopes.length > 0)) {
        return { available: false, reason: "Malformed or repeated content/page wrappers." };
      }
      envelopes.push({ name, line: index });
    }
  }
  if (fence !== undefined || envelopes.length > 0 || calloutDepth > 0) {
    return { available: false, reason: "Unclosed code fence or content/page/callout wrapper." };
  }
  const page = bounds.get("page");
  const content = bounds.get("content");
  if (page !== undefined && content !== undefined && (content.start < page.start || content.end > page.end)) {
    return { available: false, reason: "Content wrapper is outside the page wrapper." };
  }
  const body = content ?? page ?? { start: 0, end: lines.length };
  const sections: Section[] = [];
  const hierarchy: { level: number; text: string }[] = [];
  let section: Section = { index: 0, path: [], startLine: body.start, endLine: body.end, tasks: [], empty: true };
  let sectionIndex = 0;
  let taskIndex = 0;
  for (let index = body.start; index < body.end; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.fenced) {
      section.empty = false;
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/u.exec(line.body);
    if (heading !== null && heading[1] !== undefined) {
      section.endLine = index;
      const level = heading[1].length;
      // Empty ancestors organize child sections; they are not task insertion targets.
      if (section.tasks.length > 0 || (section.path.length > 0 && section.empty
        && level <= (hierarchy.at(-1)?.level ?? 0))) sections.push(section);
      while ((hierarchy.at(-1)?.level ?? 0) >= level) hierarchy.pop();
      hierarchy.push({ level, text: (heading[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/u, "").trim() });
      section = { index: ++sectionIndex, path: hierarchy.map((entry) => entry.text),
        startLine: index + 1, endLine: body.end, tasks: [], empty: true };
      continue;
    }
    const task = /^([ \t]*[-+*][ \t]+\[)([ xX])(\][ \t]+)(.*)$/u.exec(line.body);
    if (task !== null && task[1] !== undefined && task[4]?.trim()) {
      section.tasks.push({ index: taskIndex++, text: task[4].trim(), checked: task[2] !== " ",
        marker: line.start + task[1].length, prefix: task[1].slice(0, -1) });
      section.empty = false;
    } else if (!isTrailing(line.body)) {
      section.empty = false;
    }
  }
  if (section.tasks.length > 0 || (section.path.length > 0 && section.empty)) sections.push(section);
  return { available: true, lines, sections };
}

function references(text: string, binding: string): (kind: "s" | "t", index: number) => string {
  const sourceHash = createHash("sha256").update(text, "utf16le").digest("hex");
  return (kind, index) => `${kind}_${createHash("sha256")
    .update(JSON.stringify([binding, sourceHash, kind, index])).digest("hex").slice(0, 32)}`;
}

function projection(text: string, binding: string, totalSections: number, candidates: readonly Section[],
  ordering: TaskProjection["ordering"], maxBytes: number, needle?: string): TaskProjection {
  const refs = references(text, binding);
  const sections = candidates.slice(-3).map((section) => {
    const tasks = needle === undefined || section.path.some((part) => part.toLowerCase().includes(needle))
      ? section.tasks : section.tasks.filter((task) => task.text.toLowerCase().includes(needle));
    const visibleTasks = tasks.slice(-12);
    return {
      ref: refs("s", section.index), path: section.path,
      tasks: visibleTasks.map((task) => ({ ref: refs("t", task.index), text: task.text, checked: task.checked })),
      omittedTasks: section.tasks.length - visibleTasks.length,
    };
  });
  const view = (): TaskProjection => ({ view: "tasks", sourceComplete: true, available: true,
    sections, omittedSections: totalSections - sections.length, totalSections, ordering });
  while (Buffer.byteLength(JSON.stringify(view()), "utf8") > maxBytes) {
    if (sections.length === 0) fail("task_view_too_large", "Page identity and the minimal task view exceed the compact page byte limit.");
    const sectionWithTasks = sections.find((section) => section.tasks.length > 0);
    if (sectionWithTasks !== undefined) {
      sectionWithTasks.tasks.shift();
      sectionWithTasks.omittedTasks++;
    } else {
      sections.shift();
    }
  }
  return view();
}

function unavailable(reason: string, ordering: TaskProjection["ordering"], maxBytes: number): TaskProjection {
  const view: TaskProjection = { view: "tasks", sourceComplete: true, available: false, reason,
    sections: [], omittedSections: 0, totalSections: 0, ordering };
  if (Buffer.byteLength(JSON.stringify(view), "utf8") > maxBytes) {
    fail("task_view_too_large", "Page identity and the unavailable task view exceed the compact page byte limit.");
  }
  return view;
}

function viewCapacity(requested: number = MAX_VIEW_BYTES): number {
  if (!Number.isInteger(requested) || requested <= 0) {
    fail("task_view_too_large", "Page identity leaves no valid compact task view byte capacity.");
  }
  return Math.min(requested, MAX_VIEW_BYTES);
}

function isTrailing(body: string): boolean {
  return body.trim() === "" || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(body)
    || /^[ \t]*<empty-block(?:[ \t]*\/>|>[ \t]*<\/empty-block>)[ \t]*$/u.test(body);
}

function appendSplice(text: string, lines: readonly Line[], section: Section, texts: readonly string[]): Splice {
  let insertLine = section.endLine;
  while (insertLine > section.startLine) {
    const previous = lines[insertLine - 1];
    if (previous === undefined || previous.fenced || !isTrailing(previous.body)) break;
    insertLine--;
  }
  const position = lines[insertLine]?.start ?? text.length;
  const localNewline = lines.slice(Math.max(0, section.startLine - 1), section.endLine)
    .find((line) => line.newline !== "")?.newline;
  const newline = localNewline ?? lines.find((line) => line.newline !== "")?.newline ?? "\n";
  let prefix = "- ";
  let shallowestIndent = Number.POSITIVE_INFINITY;
  for (const task of section.tasks) {
    let columns = 0;
    for (const character of task.prefix) {
      if (character === " ") columns++;
      else if (character === "\t") columns += 4 - columns % 4;
      else break;
    }
    if (columns < shallowestIndent) {
      shallowestIndent = columns;
      prefix = task.prefix;
    }
  }
  const before = position > 0 && text[position - 1] !== "\n" ? newline : "";
  const after = position < text.length || text.endsWith("\n") ? newline : "";
  return { position, remove: 0, value: before + texts.map((task) => `${prefix}[ ] ${task}`).join(newline) + after };
}

function applySplices(text: string, splices: readonly Splice[], base: number): string {
  let result = text;
  for (const splice of splices) {
    const position = splice.position - base;
    result = result.slice(0, position) + splice.value + result.slice(position + splice.remove);
  }
  return result;
}

function uniquePatch(text: string, lines: readonly Line[], splices: readonly Splice[]): { oldText: string; newText: string } {
  const firstPosition = Math.min(...splices.map((splice) => splice.position));
  const lastPosition = Math.max(...splices.map((splice) => splice.position + splice.remove));
  const baseFirst = lines.findIndex((line) => line.end >= firstPosition);
  let firstLine = baseFirst;
  let lastLine = lines.findIndex((line) => line.end >= lastPosition);
  if (firstLine < 0 || lastLine < 0) fail("task_view_unavailable", "There is no nonempty source anchor for this task edit.");
  const addedLength = splices.reduce((total, splice) => total + splice.value.length - splice.remove, 0);
  const fits = (first: number, last: number): boolean => {
    const length = (lines[last]?.end ?? text.length) - (lines[first]?.start ?? 0);
    return length <= MAX_PATCH && length + addedLength <= MAX_PATCH;
  };
  if (!fits(firstLine, lastLine)) patchTooLarge();
  let growLeft = true;
  for (;;) {
    const start = lines[firstLine]?.start ?? 0;
    const end = lines[lastLine]?.end ?? text.length;
    const oldText = text.slice(start, end);
    if (oldText.length > 0 && text.indexOf(oldText) === start && text.indexOf(oldText, start + 1) === -1) {
      return { oldText, newText: applySplices(oldText, splices, start) };
    }
    if (growLeft && firstLine > 0 && fits(firstLine - 1, lastLine)) {
      firstLine--;
      continue;
    }
    growLeft = false;
    if (lastLine === lines.length - 1) patchTooLarge();
    lastLine++;
    while (!fits(firstLine, lastLine) && firstLine < baseFirst) firstLine++;
    if (!fits(firstLine, lastLine)) patchTooLarge();
  }
}

function patchTooLarge(): never {
  return fail("task_patch_too_large", "These task changes cannot fit one unique patch of at most 8000 characters. Select a smaller batch.");
}

function invalidRef(): never {
  return fail("task_ref_invalid", "Task reference is missing or stale. Read the task view for this page again in this request; do not reuse references across pages or requests.");
}

function fail(code: string, message: string): never {
  throw new ModelSafeError("NotionTaskTargetError", code, `No provider write was sent: ${message}`);
}
