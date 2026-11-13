import { ChildProcess, spawn } from "node:child_process";
import type * as ChildProcesses from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPdfText } from "../src/gmail/pdf.js";
import { PDF_MAX_BYTES, PDF_MAX_TEXT_BYTES } from "../src/gmail/pdf-protocol.js";
import { createCorruptPdf, createEncryptedPdf, createPdf } from "./fixtures/pdf.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcesses>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockClear();
});

describe("isolated PDF extraction", () => {
  it("extracts known text from actual PDF bytes without changing the input", async () => {
    const bytes = createPdf([["Submit itemized receipts within 14 days.", "Keep the original receipt."]]);
    const original = Buffer.from(bytes);
    await expect(extractPdfText(bytes)).resolves.toEqual({
      status: "read",
      text: "Submit itemized receipts within 14 days.\nKeep the original receipt.",
      pages: 1,
      pagesRead: 1,
      pagesWithoutText: [],
      truncated: false,
    });
    expect(Buffer.from(bytes)).toEqual(original);
  });

  it("preserves page boundaries and reports unread scanned pages honestly", async () => {
    await expect(extractPdfText(createPdf([["First page"], [], ["Third page"]]))).resolves.toEqual({
      status: "read",
      text: "First page\n\n[page 3]\nThird page",
      pages: 3,
      pagesRead: 2,
      pagesWithoutText: [2],
      truncated: true,
    });
  });

  it("reports a PDF with no text explicitly, without claiming OCR", async () => {
    await expect(extractPdfText(createPdf([[]]))).resolves.toMatchObject({
      status: "unavailable", reason: "no_extractable_text",
    });
  });

  it("reports a real password-encrypted PDF without leaking parser errors", async () => {
    const result = await extractPdfText(createEncryptedPdf());
    expect(result).toMatchObject({ status: "unavailable", reason: "encrypted" });
    expect(JSON.stringify(result)).not.toContain("Private synthetic policy");
  });

  it("rejects malformed bytes without leaking their contents", async () => {
    const result = await extractPdfText(Buffer.from("not a PDF: private provider content"));
    expect(result).toMatchObject({ status: "unavailable", reason: "invalid_pdf" });
    expect(JSON.stringify(result)).not.toContain("private provider content");
  });

  it("does not claim complete extraction when a later content stream is corrupt", async () => {
    const result = await extractPdfText(createCorruptPdf());
    expect(result).toMatchObject({ status: "unavailable", reason: "incomplete_pdf" });
    expect(JSON.stringify(result)).not.toContain("Readable synthetic prefix");
    expect(JSON.stringify(result)).not.toContain("corrupt synthetic compressed content");
  });

  it("reads exactly 40 pages but refuses 41 without returning partial policy text", async () => {
    const pages = Array.from({ length: 40 }, (_, index) => [`Page ${index + 1}`]);
    await expect(extractPdfText(createPdf(pages))).resolves.toMatchObject({
      status: "read", pages: 40, pagesRead: 40, truncated: false,
    });
    await expect(extractPdfText(createPdf([...pages, ["Over limit"]]))).resolves.toMatchObject({
      status: "unavailable", reason: "too_many_pages",
    });
  });

  it("caps UTF-8 bytes without splitting a multibyte character", async () => {
    const result = await extractPdfText(createPdf([["€".repeat(12_000)]]));
    expect(result.status).toBe("read");
    if (result.status !== "read") throw new Error("Expected readable PDF");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(PDF_MAX_TEXT_BYTES);
    expect(result.text).toBe("€".repeat(Math.floor(PDF_MAX_TEXT_BYTES / 3)));
    expect(result.text).not.toContain("\ufffd");
    expect(result.truncated).toBe(true);
    expect(result.pagesRead).toBe(0);
  });

  it("refuses oversized input before launching a parser", async () => {
    await expect(extractPdfText(new Uint8Array(PDF_MAX_BYTES + 1))).resolves.toMatchObject({
      status: "unavailable", reason: "parser_limit",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("maps process startup failure to sanitized unavailability", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("private process details"); });
    const result = await extractPdfText(createPdf([["text"]]));
    expect(result).toMatchObject({ status: "unavailable", reason: "parser_limit" });
    expect(JSON.stringify(result)).not.toContain("private process details");
  });


  it("does not start a process for an already-aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(extractPdfText(createPdf([["text"]]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills a stalled child at the genuine five-second wall and cleans listeners", async () => {
    vi.useFakeTimers();
    const pending = hangingParser();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const result = extractPdfText(createPdf([["text"]]), controller.signal);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pending.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: "unavailable", reason: "parser_limit" });
    expect(pending.kill).toHaveBeenCalledWith("SIGKILL");
    expect(pending.child.listenerCount("close")).toBe(0);
    expect(pending.child.listenerCount("error")).toBe(0);
    expect(pending.stdout.listenerCount("data")).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts in-flight parsing, waits for termination, and clears its deadline", async () => {
    vi.useFakeTimers();
    const pending = hangingParser();
    const controller = new AbortController();
    const result = extractPdfText(createPdf([["text"]]), controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await vi.runAllTicks();
    await assertion;
    expect(pending.kill).toHaveBeenCalledWith("SIGKILL");
    expect(pending.child.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds child output and converts crashes to sanitized unavailability", async () => {
    const pending = hangingParser();
    const result = extractPdfText(createPdf([["text"]]));
    pending.stdout.write(Buffer.alloc(128 * 1024 + 1, 0x61));
    await expect(result).resolves.toMatchObject({ status: "unavailable", reason: "parser_limit" });
    expect(pending.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects malformed child results instead of exposing arbitrary parser messages", async () => {
    const pending = hangingParser();
    const result = extractPdfText(createPdf([["text"]]));
    pending.stdout.write('{"status":"read","text":"private","pages":100000}');
    pending.child.emit("close", 0);
    await expect(result).resolves.toMatchObject({ status: "unavailable", reason: "parser_limit" });
  });

  it("serializes concurrent parsers and releases the next PDF after a child fails", async () => {
    const pending = hangingParser();
    const first = extractPdfText(createPdf([["stalled"]]));
    const second = extractPdfText(createPdf([["The next policy remains readable."]]));
    expect(spawn).toHaveBeenCalledTimes(1);
    pending.kill("SIGKILL");
    await expect(first).resolves.toMatchObject({ status: "unavailable", reason: "parser_limit" });
    await expect(second).resolves.toMatchObject({
      status: "read", text: "The next policy remains readable.",
    });
  });
});

function hangingParser() {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.defineProperties(child, { stdin: { value: stdin }, stdout: { value: stdout } });
  const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  vi.mocked(spawn).mockReturnValueOnce(child);
  return { child, stdout, kill };
}
