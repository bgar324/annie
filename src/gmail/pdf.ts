import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_MAX_BYTES,
  PDF_TIMEOUT_MS,
  pdfTextResultSchema,
  pdfUnavailableMessages,
  type PdfTextResult,
} from "./pdf-protocol.js";

export type { PdfTextResult } from "./pdf-protocol.js";

let parserTail: Promise<void> | null = null;

/** Parses untrusted bytes outside the service process, including during tsx development. */
export async function extractPdfText(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfTextResult> {
  signal?.throwIfAborted();
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { status: "unavailable", reason: "parser_limit", message: pdfUnavailableMessages.parser_limit };
  }

  // One child at a time also bounds aggregate parser memory across parallel tool calls.
  const previous = parserTail;
  const { promise, resolve: release } = Promise.withResolvers<void>();
  parserTail = promise;
  try {
    if (previous !== null) await previous;
    signal?.throwIfAborted();
    return await runPdfParser(bytes, signal);
  } finally {
    release();
    if (parserTail === promise) parserTail = null;
  }
}

async function runPdfParser(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfTextResult> {
  const compiled = import.meta.url.endsWith(".js");
  const limitData = compiled && process.platform === "linux";
  const workerUrl = new URL(compiled ? "./pdf-worker.js" : "./pdf-worker.ts", import.meta.url);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const projectDirectory = resolve(moduleDirectory, "../..");
  const fallback: PdfTextResult = {
    status: "unavailable", reason: "parser_limit", message: pdfUnavailableMessages.parser_limit,
  };

  return new Promise<PdfTextResult>((resolveResult, reject) => {
    // The child gets no credentials, filesystem writes, addons, subprocesses, or worker threads.
    // Production's Linux data limit covers malloc/mmap backing ArrayBuffers.
    // Source development needs WebAssembly for Node's TypeScript stripping, so cannot
    // run jitless; only compiled production workers get the OS data limit.
    const nodeArguments = [
      ...(compiled ? ["--jitless"] : []),
      "--max-old-space-size=96",
      "--max-semi-space-size=8",
      "--disallow-code-generation-from-strings",
      "--disable-proto=throw",
      "--disable-sigusr1",
      "--permission",
      `--allow-fs-read=${moduleDirectory}`,
      `--allow-fs-read=${resolve(projectDirectory, "package.json")}`,
      `--allow-fs-read=${realpathSync(resolve(projectDirectory, "node_modules"))}`,
      fileURLToPath(workerUrl),
    ];
    const child = spawn(
      limitData ? "/bin/sh" : process.execPath,
      limitData
        ? ["-c", 'ulimit -S -d 196608 && ulimit -H -d 196608 && exec "$@"', "pdf-parser", process.execPath, ...nodeArguments]
        : nodeArguments,
      {
        cwd: moduleDirectory,
        env: { NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let failed = false;
    let aborted = false;
    const terminate = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const onData = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 128 * 1024) {
        terminate();
      } else if (!failed) {
        chunks.push(chunk);
      }
    };
    const timer = setTimeout(terminate, PDF_TIMEOUT_MS);
    child.stdout.on("data", onData);
    child.on("error", terminate);
    child.stdin.on("error", terminate);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", terminate);
      child.stdin.removeListener("error", terminate);
      if (aborted) {
        reject(signal?.reason ?? new DOMException("PDF extraction aborted", "AbortError"));
        return;
      }
      if (failed || code !== 0) {
        resolveResult(fallback);
        return;
      }
      try {
        const parsed = pdfTextResultSchema.safeParse(JSON.parse(Buffer.concat(chunks, outputBytes).toString("utf8")));
        if (!parsed.success) {
          resolveResult(fallback);
        } else if (parsed.data.status === "unavailable") {
          resolveResult({ ...parsed.data, message: pdfUnavailableMessages[parsed.data.reason] });
        } else {
          resolveResult(parsed.data);
        }
      } catch {
        resolveResult(fallback);
      }
    });
    if (signal?.aborted) {
      onAbort();
    } else {
      child.stdin.end(bytes);
    }
  }).catch(() => {
    signal?.throwIfAborted();
    return fallback;
  });
}
