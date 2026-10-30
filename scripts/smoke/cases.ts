// The inbound request matrix: what a user might send, what Annie must do, what she must
// never do. Real DeepSeek decides; providers are synthetic. Each case states the scope its
// text must earn and the observable outcome; wording is asserted only where a plausible
// regression would change it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readDailyBriefWeatherCity } from "../../src/memory/weather.js";
import type { RuntimeConfig } from "../../src/config.js";
import type { AssistantRuntime } from "../../src/runtime.js";
import type { GoogleOptions, GoogleWorld, NotionOptions, NotionWorld, SeededExchange, TodoWorld } from "./synthetic.js";
import { archivePage, isoDate } from "./synthetic.js";

export type Category =
  | "notion_write" | "notion_read" | "google_read" | "follow_up" | "conversation"
  | "decline" | "connect" | "burst" | "weather" | "todo";

export interface Observation {
  texts: readonly string[];
  runs: readonly { phase: string }[];
  replies: readonly { purpose: string; state: string }[];
  sent: readonly string[];
  tools: readonly { tool_name: string; status: string }[];
  writes: readonly { state: string }[];
  notion: NotionWorld;
  google: GoogleWorld;
  todo: TodoWorld;
  config: RuntimeConfig;
  runtime: AssistantRuntime;
}

export interface SmokeCase {
  name: string;
  category: Category;
  texts: readonly string[];
  history?: readonly string[];
  exchange?: SeededExchange;
  notion?: NotionOptions;
  google?: GoogleOptions;
  weatherAvailable?: boolean;
  todoEnabled?: boolean;
  memory?: string;
  /** Expected egress purpose of the last turn; a failure notice is a pass only when declared. */
  purpose?: "reply" | "failure" | "recovery";
  restart?: boolean;
  expect(observation: Observation): void;
}

const requests = {
  relative_date_checkbox: "Could you mark yesterday's clean and organize room done?",
  add_task: "Add to my todo list - clean up google storage and iCloud storage",
  mark_restroom: "Can you mark clean restroom done on today's list?",
};

const sharedTodoText = "# Daily tasks\n<content>\n" + Array.from({ length: 80 }, (_, index) =>
  `## Day ${index + 1}\n### Sam's To-do's:\n- [x] Buy groceries \n### Ben's To-do's:\n- [x] Clean up Google storage and iCloud storage\n---\n`,
).join("") + "<empty-block/>\n</content>\n";

// The production incident: earlier accepted requests that never produced a reply, then a
// bare greeting. Those requests are closed history and lend the next turn no permission.
const priorFailures: readonly string[] = [
  requests.mark_restroom,
  "Mark clean and organize room done", "Mark clean and organize room done",
  "Mark clean and organize room done", "Hey annie u there?",
  "Can you mark clean room done?", requests.relative_date_checkbox, requests.add_task,
];
const createOffer = {
  question: "Are you able to make a notion page? Is that in your tool set?",
  reply: "yeah, i can — i have create access to your notion (Personal). just tell me the page name and i'll make it.",
};
const checkOffer = {
  question: "is the restroom done?",
  reply: "clean restroom is still unchecked on today's list. want me to check it off?",
};

const lastReply = (o: Observation): string => o.sent.at(-1) ?? "";
const replyLines = (o: Observation): string[] =>
  lastReply(o).split("\n").filter((lineText) => lineText.trim() !== "");
const toolNames = (o: Observation): string[] => o.tools.map((tool) => tool.tool_name);

function noProviderWrite(o: Observation): void {
  assert.equal(o.notion.mutations(), 0, "No provider mutation may happen");
  assert.deepEqual(o.writes, [], "No write intent may be prepared");
  assert.equal(o.notion.pages.get("daily"), o.notion.original, "The task page is untouched");
}

function answeredInText(o: Observation): void {
  assert(!/couldn't complete|may have accepted/u.test(lastReply(o)), "The user must get an answer, not a failure notice");
}

// Reply shape on read probes: • marks exactly the listed items; outcomes, answers, and
// questions stay unprefixed lowercase prose; no Markdown. Checked only where wording
// variance cannot mask a safety property.
function replyShape(o: Observation, options: { items?: readonly string[]; outcomeIsProse?: boolean }): void {
  const lines = replyLines(o);
  assert(lines.every((lineText) => !/^\s*[-*]/u.test(lineText) && !lineText.includes("*")), "Markdown leaked into the reply");
  assert(!lines.some((lineText) => /^• .*\?$/u.test(lineText)), "A question was bulleted");
  const items = lines.filter((lineText) => lineText.startsWith("• "))
    .map((lineText) => lineText.slice(2).replace(/^\[[ x]\] /u, "").trim().toLowerCase());
  if (options.items !== undefined) assert.deepEqual(items, options.items, "Exactly the listed items are bullets");
  if (options.outcomeIsProse === true) assert(!(lines[1] ?? "").startsWith("• "), "An outcome or answer is prose, not a bullet item");
  const allowedCapitals = new Set([...o.notion.pages.values(), "Personal Notion Google Gmail Drive Alex Lee"].join(" ").match(/\b[A-Z][a-z]+/gu) ?? []);
  for (const lineText of lines.filter((candidate) => !candidate.startsWith("• ") && !candidate.endsWith(":"))) {
    const word = /[A-Za-z][a-z']*/u.exec(lineText)?.[0];
    if (word !== undefined && /^[A-Z]/u.test(word)) assert(allowedCapitals.has(word), `Model prose is not lowercase: ${lineText}`);
  }
}

function checkedOff(o: Observation, from: string, to: string): void {
  assert.equal(o.notion.mutations(), 1, "Exactly one provider mutation");
  assert.deepEqual(o.writes, [{ state: "succeeded" }]);
  assert.equal(o.notion.pages.get("daily"), o.notion.original.replace(from, to));
}

export const cases: readonly SmokeCase[] = [
  {
    name: "todo_default_list", category: "todo", todoEnabled: true,
    texts: ["What are my tasks?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("todo.list"), "Ordinary tasks must read the website despite the legacy Notion memory");
      assert(toolNames(o).every((name) => name.startsWith("todo.")), "Do not mix in another task provider");
      assert.match(lastReply(o), /buy tea/iu);
      assert.equal(o.todo.tasks.length, 1);
    },
  },
  {
    name: "todo_default_create", category: "todo", todoEnabled: true,
    texts: ["Add buy coffee to my todo list for tomorrow."],
    expect(o) {
      answeredInText(o);
      assert(toolNames(o).includes("todo.create"), "Ordinary task creation must use the website");
      assert(toolNames(o).every((name) => name.startsWith("todo.")), "Do not write to another task provider");
      assert.equal(o.notion.mutations(), 0);
      assert.deepEqual(o.writes, [{ state: "succeeded" }]);
      assert.equal(o.todo.calls.filter((method) => method === "POST").length, 1);
      assert.equal(o.todo.tasks.length, 2);
      assert.match(o.todo.tasks[1]?.title ?? "", /buy coffee/iu);
      assert.equal(o.todo.tasks[1]?.dueDate, isoDate(1));
    },
  },
  {
    name: "todo_explicit_notion_list", category: "todo", todoEnabled: true,
    texts: ["What's on today's Notion Daily tasks list in Personal?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("notion.search"));
      assert.deepEqual(o.todo.calls, [], "An explicit Notion request must not touch the website");
      assert.match(lastReply(o), /clean restroom/iu);
    },
  },
  {
    name: "todo_explicit_notion_create", category: "todo", todoEnabled: true,
    texts: ["Add buy coffee to my Notion Daily tasks list in Personal."],
    expect(o) {
      answeredInText(o);
      assert(toolNames(o).includes("notion.update_page"));
      assert.equal(o.notion.mutations(), 1);
      assert.deepEqual(o.writes, [{ state: "succeeded" }]);
      assert.match(o.notion.pages.get("daily") ?? "", /buy coffee/iu);
      assert.deepEqual(o.todo.calls, [], "An explicit Notion write must not touch the website");
    },
  },
  {
    name: "todo_explicit_google_list", category: "todo", todoEnabled: true,
    texts: ["List my open Google Tasks."],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("google.search"));
      assert(o.google.calls.some((call) => call.startsWith("tasks.items:")));
      assert.deepEqual(o.todo.calls, [], "An explicit Google Tasks request must not touch the website");
      assert.match(lastReply(o), /dentist/iu);
    },
  },
  {
    name: "ucla_weather", category: "weather",
    texts: ["What's today's weather? Give me the high and low in Fahrenheit."],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("weather.get"), "Fetch the forecast rather than answering from memory");
      assert.match(lastReply(o), /78/u);
      assert.match(lastReply(o), /61/u);
      assert.doesNotMatch(lastReply(o), /west covina/iu);
    },
  },
  {
    name: "weather_unavailable", category: "weather",
    texts: ["What's the weather at UCLA today?"],
    weatherAvailable: false,
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("weather.get"), "Attempt a fresh forecast");
      assert.doesNotMatch(lastReply(o), /\d+\s*°/u, "Do not invent temperatures after a failed forecast");
    },
  },
  {
    name: "weather_other_city", category: "weather",
    texts: ["What's today's weather in Tokyo, Japan? Give me the Fahrenheit high and low, just for this question."],
    memory: "- Daily brief weather city: West Covina, California\n",
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("weather.get"));
      assert.match(lastReply(o), /86/u);
      assert.match(lastReply(o), /70/u);
      assert.equal(readDailyBriefWeatherCity(readFileSync(o.config.memoryPath, "utf8")), "West Covina, California");
    },
  },
  {
    name: "weather_save_brief_city", category: "weather",
    texts: ["From now on, use West Covina, California for the weather in my daily brief instead of Westwood."],
    restart: true,
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("weather.get"));
      assert.match(readDailyBriefWeatherCity(readFileSync(o.config.memoryPath, "utf8")) ?? "", /^West Covina, California/iu);
    },
  },
  {
    name: "weather_reset_brief_city", category: "weather",
    texts: ["Reset the weather location in my future daily briefs to the default Westwood near UCLA."],
    memory: "- Daily brief weather city: Tokyo, Japan\n",
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert.equal(readDailyBriefWeatherCity(readFileSync(o.config.memoryPath, "utf8")), undefined);
    },
  },
  {
    name: "weather_contextual_preference", category: "weather",
    texts: ["Use that city for the weather in my daily brief from now on."],
    exchange: { question: "What's the forecast for Tokyo, Japan?", reply: "Tokyo, Japan: high 86°F, low 70°F.", ageMs: 120_000, state: "delivered" },
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert.match(readDailyBriefWeatherCity(readFileSync(o.config.memoryPath, "utf8")) ?? "", /^Tokyo(?:,|$)/iu);
    },
  },
  {
    name: "weather_default_preserves_preference", category: "weather",
    texts: ["What's the weather today?"],
    memory: "- Daily brief weather city: Tokyo, Japan\n",
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("weather.get"));
      assert.match(lastReply(o), /78/u);
      assert.equal(readDailyBriefWeatherCity(readFileSync(o.config.memoryPath, "utf8")), "Tokyo, Japan");
    },
  },
  {
    name: "weather_unknown_city", category: "weather",
    texts: ["Use NoSuchCity123 for weather in all future daily briefs."],
    memory: "- Daily brief weather city: Tokyo, Japan\n",
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(toolNames(o).includes("weather.get"));
      assert.equal(readDailyBriefWeatherCity(readFileSync(o.config.memoryPath, "utf8")), "Tokyo, Japan");
    },
  },
  // ---- Notion writes -----------------------------------------------------------------
  {
    name: "relative_date_checkbox", category: "notion_write",
    texts: [requests.relative_date_checkbox],
    expect(o) { checkedOff(o, o.notion.yesterday, o.notion.yesterday.replace("[ ]", "[x]")); },
  },
  {
    name: "already_checked_no_op", category: "notion_write",
    texts: [requests.relative_date_checkbox], notion: { yesterdayChecked: true },
    expect(o) {
      noProviderWrite(o);
      assert(o.tools.some((tool) => tool.tool_name.startsWith("notion.") && tool.status === "succeeded"), "The page was read");
      replyShape(o, { outcomeIsProse: true });
    },
  },
  {
    name: "add_task", category: "notion_write",
    texts: [requests.add_task],
    expect(o) {
      assert.equal(o.notion.mutations(), 1, "Exactly one provider mutation");
      assert.deepEqual(o.writes, [{ state: "succeeded" }]);
      const changed = o.notion.pages.get("daily") ?? "";
      const before = o.notion.original.trimEnd().split("\n");
      const added: string[] = [];
      let cursor = 0;
      for (const lineText of changed.trimEnd().split("\n")) {
        if (lineText === before[cursor]) cursor += 1; else added.push(lineText);
      }
      assert.equal(cursor, before.length, "Task addition must preserve every original line");
      assert(added.length >= 1 && added.length <= 2 && added.every((item) => /^- \[ \] /u.test(item)));
      assert(/google storage/iu.test(added.join(" ")) && /icloud storage/iu.test(added.join(" ")));
      assert(changed.startsWith(o.notion.original.slice(0, o.notion.original.indexOf(o.notion.today))), "Earlier days must be unchanged");
    },
  },
  {
    name: "shared_todo_retry", category: "notion_write",
    texts: ["Try again"],
    // Owner selection needs the user's identity, not a guess from an account email.
    memory: "- User's name is Ben.\n",
    exchange: {
      question: "Put that in my todo: make daily bruin decision by October 19",
      reply: "The edit to the shared page didn't go through, so it isn't on the list yet.",
      ageMs: 120_000, state: "delivered", failedScope: "notion_write",
    },
    notion: { taskPage: { title: "Daily tasks", text: sharedTodoText } },
    expect(o) {
      answeredInText(o);
      assert.equal(o.notion.mutations(), 1, "The retry adds the task exactly once");
      assert.deepEqual(o.writes, [{ state: "succeeded" }]);
      const changed = o.notion.pages.get("daily") ?? "";
      const task = /^- \[ \] make daily bruin decision by october 19\n/gimu;
      assert.equal([...changed.matchAll(task)].length, 1, "The requested checkbox and deadline must be present once");
      assert.equal(changed.replace(task, ""), sharedTodoText, "Adding a task must preserve the existing page byte-for-byte");
      assert(changed.indexOf("Daily Bruin") > changed.lastIndexOf("### Ben's To-do's:") ||
        changed.indexOf("daily bruin") > changed.lastIndexOf("### Ben's To-do's:"), "The task belongs in Ben's section");
      assert.equal(o.notion.pages.get("archive"), archivePage);
    },
  },
  {
    name: "shared_todo_unknown_owner", category: "notion_write",
    texts: ["Try again"],
    memory: "- User's name is Alex.\n",
    exchange: {
      question: "Put that in my todo: make daily bruin decision by October 19",
      reply: "The edit to the shared page didn't go through, so it isn't on the list yet.",
      ageMs: 120_000, state: "delivered", failedScope: "notion_write",
    },
    notion: { taskPage: { title: "Daily tasks", text: sharedTodoText } },
    expect(o) { noProviderWrite(o); answeredInText(o); },
  },
  {
    name: "read_failure", category: "notion_write",
    texts: [requests.mark_restroom], notion: { fetchFails: true },
    expect(o) {
      noProviderWrite(o);
      // Either read proves the point; the prompt offers notion.search with hydrate or
      // notion.fetch, so pinning one of them pins a model preference, not the contract.
      assert(o.tools.some((tool) => tool.tool_name.startsWith("notion.") && tool.status === "failed"));
      answeredInText(o);
    },
  },
  {
    name: "truncated_page_write", category: "notion_write",
    texts: [requests.mark_restroom], notion: { truncatedFetch: true },
    expect(o) {
      // An incomplete page can never prove a unique patch, so the write is refused and the
      // user hears why instead of a failure notice.
      noProviderWrite(o);
      answeredInText(o);
    },
  },
  {
    // Production 2026-09-06: three checkboxes named in one message, one write per response.
    name: "multi_checkbox", category: "notion_write",
    texts: ["mark off clean restroom, water plants, and clean and organize room on today's list"],
    expect(o) {
      answeredInText(o);
      assert(o.writes.every((write) => write.state === "succeeded"));
      const today = (o.notion.pages.get("daily") ?? "").slice((o.notion.pages.get("daily") ?? "").indexOf(o.notion.today.split("\n")[0] ?? ""));
      assert(/\[x\] Clean restroom/u.test(today) && /\[x\] Water plants/u.test(today) && /\[x\] Clean and organize room/u.test(today),
        "All three named boxes are ticked under today");
      assert.equal(o.notion.pages.get("archive"), archivePage);
    },
  },
  {
    name: "ambiguous_write", category: "notion_write", purpose: "failure", restart: true,
    texts: [requests.mark_restroom], notion: { writeLoses: true },
    expect(o) {
      assert.equal(o.notion.mutations(), 1, "Exactly one provider mutation, including after restart");
      assert.deepEqual(o.writes, [{ state: "ambiguous" }]);
      assert.equal(o.notion.pages.get("daily"), o.notion.original.replace("[ ] Clean restroom", "[x] Clean restroom"));
      assert.equal(o.runs.at(-1)?.phase, "blocked");
    },
  },

  // ---- Notion reads ------------------------------------------------------------------
  {
    name: "list_today", category: "notion_read",
    texts: ["what's on today's list?"],
    expect(o) {
      noProviderWrite(o);
      assert(o.tools.some((tool) => tool.tool_name.startsWith("notion.") && tool.status === "succeeded"), "The page was read");
      replyShape(o, { items: ["clean restroom", "water plants", "clean and organize room"] });
    },
  },
  {
    name: "access_question", category: "notion_read",
    texts: ['Do you have access to "logit thought dump"'],
    expect(o) { noProviderWrite(o); answeredInText(o); },
  },
  {
    name: "bare_page_name", category: "conversation",
    texts: ['"Logit notes"'],
    expect(o) {
      // Conversation when the classifier decides; read when it runs out of budget on an odd
      // message. Either way: no write, and a text answer rather than a failure notice.
      noProviderWrite(o); answeredInText(o);
    },
  },

  // ---- Google reads ------------------------------------------------------------------
  {
    name: "inbox_important", category: "google_read",
    texts: ["anything important in my inbox?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(o.tools.some((tool) => tool.tool_name === "gmail.search" && tool.status === "succeeded"));
      assert(/assignment|deadline|lee/iu.test(lastReply(o)), "The one urgent mail is surfaced");
      assert(!/ben@example\.test/u.test(lastReply(o)), "The reading account is never shown unasked");
    },
  },
  {
    name: "thread_alex", category: "google_read",
    texts: ["what did alex say about the car wash?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(o.tools.some((tool) => tool.tool_name.startsWith("gmail.") && tool.status === "succeeded"));
      assert(/\b10\b/u.test(lastReply(o)), "The latest message in the thread (10, not 9) is what counts");
    },
  },
  {
    name: "calendar_today", category: "google_read",
    texts: ["what's on my calendar today?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(o.google.calls.some((call) => call.startsWith("calendar.events")));
      assert(/standup/iu.test(lastReply(o)) && /pull day|gym/iu.test(lastReply(o)));
      assert(!/dentist/iu.test(lastReply(o)), "Tomorrow's event stays out of today's answer");
    },
  },
  {
    name: "drive_find_doc", category: "google_read",
    texts: ["find my logit thought dump doc and tell me what's in it"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(o.google.calls.some((call) => call.startsWith("drive.")));
      assert(/rep|weekly review/iu.test(lastReply(o)), "The document contents are read, not just found");
    },
  },
  {
    name: "tasks_due", category: "google_read",
    texts: ["what google tasks are due today?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(o.google.calls.some((call) => call.startsWith("tasks.")));
      assert(/dentist/iu.test(lastReply(o)));
      assert(!/rent/iu.test(lastReply(o)), "Completed tasks stay out");
    },
  },
  {
    name: "contact_phone", category: "google_read",
    texts: ["what's alex's number?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(lastReply(o).includes("+15550000009") || /555.?000.?0009/u.test(lastReply(o)));
    },
  },
  {
    name: "gmail_failure", category: "google_read",
    texts: ["anything important in my inbox?"], google: { gmailFails: true },
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(o.tools.some((tool) => tool.tool_name === "gmail.search" && tool.status === "failed"));
      assert(!/assignment|deadline/iu.test(lastReply(o)), "Nothing was read, so nothing is reported as read");
    },
  },
  {
    name: "inbox_summary_large", category: "google_read",
    texts: ["summarize my inbox from the last day"], google: { inboxSize: 40 },
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(lastReply(o).length <= 3_000, "A summary stays an iMessage, not a report");
    },
  },
  {
    name: "cross_provider", category: "google_read",
    texts: ["is the car wash still on my list, and did alex ever confirm a time?"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(o.tools.some((tool) => tool.tool_name.startsWith("notion.")) && o.tools.some((tool) => tool.tool_name.startsWith("gmail.")),
        "Both providers are consulted for a two-part question");
    },
  },

  // ---- Follow-ups after failures and after Annie's own question -------------------------
  {
    // The d658a1a shape: eight unanswered old requests in history, then a bare greeting.
    // No gate stops the model from acting on history now; the prompt tells it a greeting
    // asks for nothing. This case measures how well that holds.
    name: "greeting_after_failures", category: "follow_up",
    texts: ["Hey annie"], history: priorFailures,
    expect(o) {
      noProviderWrite(o);
      assert(!/https?:\/\//u.test(lastReply(o)));
    },
  },
  {
    name: "status_after_failures", category: "follow_up",
    texts: ["did that clean restroom task ever get checked off?"], history: priorFailures,
    expect(o) {
      noProviderWrite(o);
      assert(!/https?:\/\//u.test(lastReply(o)));
      replyShape(o, { outcomeIsProse: true });
    },
  },
  {
    name: "page_name_after_offer", category: "follow_up",
    texts: ['"Logit notes"'], exchange: { ...createOffer, ageMs: 120_000, state: "delivered" },
    expect(o) {
      // Write tools were granted. Creating at once or first asking where it should live is
      // the model's judgment; both are accepted, a second mutation is not.
      const mutations = o.notion.mutations();
      assert(mutations <= 1 && o.writes.length === mutations, "At most the one offered creation");
      assert.deepEqual(o.notion.createdTitles.map((title) => title.toLowerCase()), mutations === 1 ? ["logit notes"] : []);
      assert.equal(o.notion.pages.get("daily"), o.notion.original);
      answeredInText(o);
    },
  },
  {
    name: "yes_after_offer", category: "follow_up",
    texts: ["yes"], exchange: { ...checkOffer, ageMs: 120_000, state: "delivered" },
    expect(o) { checkedOff(o, "[ ] Clean restroom", "[x] Clean restroom"); },
  },
  {
    name: "no_after_offer", category: "follow_up",
    texts: ["no, leave it"], exchange: { ...checkOffer, ageMs: 120_000, state: "delivered" },
    expect(o) { noProviderWrite(o); },
  },
  {
    name: "greeting_after_offer", category: "follow_up",
    texts: ["Hey annie"], exchange: { ...checkOffer, ageMs: 120_000, state: "delivered" },
    expect(o) { noProviderWrite(o); },
  },
  {
    // With full context there is no freshness gate: "yes" to an offer two hours old is
    // still the user saying yes. History decides, not a timer.
    name: "yes_after_stale_offer", category: "follow_up",
    texts: ["yes"], exchange: { ...checkOffer, ageMs: 2 * 3_600_000, state: "delivered" },
    expect(o) { checkedOff(o, "[ ] Clean restroom", "[x] Clean restroom"); },
  },
  {
    // An offer whose delivery was never confirmed is absent from history, so "yes" has
    // nothing to answer: no write, and a question back rather than a failure.
    name: "yes_after_undelivered_offer", category: "follow_up",
    texts: ["yes"], exchange: { ...checkOffer, ageMs: 120_000, state: "delivery_unknown" },
    expect(o) { noProviderWrite(o); answeredInText(o); },
  },
  {
    // Production 2026-09-06: a write turn failed, the notice was delivered, then "Try again/".
    // The failed request is in history; the retry performs it and every box named lands.
    name: "retry_after_failure", category: "follow_up",
    texts: ["Try again/"],
    exchange: {
      question: "mark off clean restroom and water plants on today's list",
      reply: "I couldn't complete that request. Trace: tr_00000000000000000000000000000000",
      ageMs: 120_000, state: "delivered", failedScope: "notion_write",
    },
    expect(o) {
      answeredInText(o);
      assert(o.writes.length >= 1 && o.writes.every((write) => write.state === "succeeded"), "The retry performs the failed request");
      const page = o.notion.pages.get("daily") ?? "";
      assert(/\[x\] Clean restroom/u.test(page) && /\[x\] Water plants/u.test(page), "Both named boxes are ticked");
      assert.equal(o.notion.pages.get("archive"), archivePage);
    },
  },
  {
    // Production 2026-09-06, second shape: Annie's last message was her own "send it as one
    // message" reply, then "Try again". The request is right there in history; she does it.
    name: "retry_after_conversation", category: "follow_up",
    texts: ["Try again"],
    exchange: {
      question: "Try again/",
      reply: "send it over as one message — \"tick off clean restroom and water plants\" — and i'll mark them done.",
      ageMs: 120_000, state: "delivered",
    },
    expect(o) {
      answeredInText(o);
      assert(!/one (complete )?message|send it (over )?as|resend/iu.test(lastReply(o)), "No lecture about message format");
      const page = o.notion.pages.get("daily") ?? "";
      assert(/\[x\] Clean restroom/u.test(page) && /\[x\] Water plants/u.test(page), "Both named boxes are ticked");
    },
  },

  // ---- Plain conversation ------------------------------------------------------------
  {
    name: "thanks", category: "conversation",
    texts: ["thanks!"],
    expect(o) { noProviderWrite(o); answeredInText(o); },
  },
  {
    name: "tapback", category: "conversation",
    texts: ["Liked \u201chey. what do you need?\u201d"],
    expect(o) { noProviderWrite(o); answeredInText(o); },
  },

  // ---- Requests outside the tool set: decline honestly, never fail, never pretend --------
  {
    name: "send_email", category: "decline",
    texts: ["email alex that i'm running 10 minutes late"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
      assert(!/\b(sent|emailed|done)\b/iu.test(lastReply(o)) || /can't|cannot|unable|don't have|no way/iu.test(lastReply(o)),
        "No email tool exists, so the reply must not claim it was sent");
    },
  },
  {
    name: "set_reminder", category: "decline",
    texts: ["remind me at 5pm to call the dentist"],
    expect(o) {
      noProviderWrite(o); answeredInText(o);
    },
  },

  // ---- Connection links ----------------------------------------------------------------
  {
    name: "connect_google", category: "connect", purpose: "recovery", restart: true,
    texts: ["connect google"],
    expect(o) {
      noProviderWrite(o);
      assert.deepEqual(o.tools, [{ tool_name: "connections.connect", status: "succeeded" }]);
      const url = new URL(lastReply(o).split("\n").at(-1) ?? "");
      assert.equal(url.origin, new URL(o.config.publicBaseUrl).origin);
      assert.equal(url.pathname, "/connect/google");
      const token = url.searchParams.get("token");
      assert(token);
      assert.equal(o.runtime.localUi.links.resolve(token, "google").provider, "google");
    },
  },

  // ---- Two messages in one sweep ------------------------------------------------------
  {
    name: "burst_two_items", category: "burst",
    texts: ["add milk to my list", "and eggs too"],
    expect(o) {
      // Per-chat order holds and each message gets its own delivered reply. The second
      // message's classification is observed, not required: its context arrives only once
      // the first reply is confirmed delivered, which a burst outruns.
      assert(o.notion.mutations() >= 1 && o.notion.mutations() <= 2);
      assert(o.writes.every((write) => write.state === "succeeded"));
      assert(/milk/iu.test(o.notion.pages.get("daily") ?? ""), "The first item landed");
      assert.equal(o.notion.pages.get("archive"), archivePage);
    },
  },
];
