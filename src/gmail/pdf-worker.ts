// Node 24 needs PDF.js's bundled Uint8Array.toHex and other compatibility polyfills.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api.js";
import type { PdfTextResult } from "./pdf-protocol.js";
import type * as PdfProtocol from "./pdf-protocol.js";

// Node 24 strips this source file's types in development; production runs emitted JS.
const protocolUrl = new URL(import.meta.url.endsWith(".ts") ? "./pdf-protocol.ts" : "./pdf-protocol.js", import.meta.url);
const {
  PDF_MAX_BYTES, PDF_MAX_PAGES, PDF_MAX_TEXT_BYTES, pdfUnavailableMessages,
}: typeof PdfProtocol = await import(protocolUrl.href);

// PDF.js can recover from a corrupt content stream despite stopAtErrors. Such a
// recovery must not turn a readable prefix into a supposedly complete document.
let parsing = false;
let parserWarning = false;
console.log = console.warn = console.error = console.info = console.debug = () => {
  if (parsing) parserWarning = true;
};
// Only in-memory PDF data and bundled local fonts/CMaps are used. No URL is accepted.
globalThis.fetch = async () => { throw new Error("Network access is disabled in PDF extraction"); };

function unavailable(reason: keyof typeof pdfUnavailableMessages): PdfTextResult {
  return { status: "unavailable", reason, message: pdfUnavailableMessages[reason] };
}

async function extract(): Promise<PdfTextResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > PDF_MAX_BYTES) return unavailable("parser_limit");
    chunks.push(bytes);
  }
  // A plain Uint8Array view avoids Buffer's unsupported transfer semantics, without copying.
  const input = Buffer.concat(chunks, size);
  parsing = true;
  const loading = getDocument({
    data: new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    useWorkerFetch: false,
    useSystemFonts: true,
    useWasm: false,
    disableFontFace: true,
    disableWorkerRendering: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    maxImageSize: 0,
    verbosity: 1,
  });
  try {
    const document = await loading.promise;
    if (document.numPages > PDF_MAX_PAGES) return unavailable("too_many_pages");
    const parts: string[] = [];
    const pagesWithoutText: number[] = [];
    let textBytes = 0;
    let pagesRead = 0;
    let truncated = false;
    let hasText = false;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const reader = page.streamTextContent().getReader();
      let pageHasText = false;
      let previousItem: TextItem | undefined;
      let pageStarted = false;
      try {
        while (true) {
          const chunk: { done: boolean; value?: TextContent } = await reader.read();
          if (chunk.done) break;
          if (!chunk.value) return unavailable("parser_limit");
          for (const item of chunk.value.items) {
            if (!("str" in item)) continue;
            const text = item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
            if (text.trim()) pageHasText = true;
            let separator = "";
            if (!pageStarted && text.trim()) {
              separator = parts.length ? `\n\n[page ${pageNumber}]\n` : "";
              pageStarted = true;
            } else if (previousItem && text) {
              const previousY = previousItem.transform[5];
              const currentY = item.transform[5];
              separator = previousItem.hasEOL || Math.abs(currentY - previousY) > Math.max(2, item.height * 0.5) ? "\n" : " ";
            }
            const addition = separator + text;
            const bytesRemaining = PDF_MAX_TEXT_BYTES - textBytes;
            const additionBytes = Buffer.byteLength(addition, "utf8");
            if (additionBytes > bytesRemaining) {
              const encoded = Buffer.from(addition.slice(0, bytesRemaining + 1), "utf8");
              let end = bytesRemaining;
              // Do not cut a UTF-8 sequence and accidentally introduce replacement characters.
              while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
              if (end) parts.push(encoded.subarray(0, end).toString("utf8"));
              truncated = true;
              break;
            }
            if (addition) parts.push(addition);
            textBytes += additionBytes;
            previousItem = item;
          }
          if (truncated) break;
        }
      } finally {
        // PDF.js's stream transport requires an Error cancellation reason.
        await reader.cancel(new Error("PDF text extraction finished")).catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      hasText ||= pageHasText;
      if (truncated) break;
      if (pageHasText) pagesRead++;
      else pagesWithoutText.push(pageNumber);
    }
    if (parserWarning) return unavailable("incomplete_pdf");
    if (!hasText) return unavailable("no_extractable_text");
    return {
      status: "read",
      text: parts.join("").trim(),
      pages: document.numPages,
      pagesRead,
      pagesWithoutText,
      truncated: truncated || pagesWithoutText.length > 0,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") return unavailable("encrypted");
    if (error instanceof Error && (error.name === "InvalidPDFException" || error.name === "UnknownErrorException")) {
      return unavailable("invalid_pdf");
    }
    return unavailable("parser_limit");
  } finally {
    await loading.destroy().catch(() => {});
  }
}

let result: PdfTextResult;
try {
  result = await extract();
} catch {
  result = unavailable("parser_limit");
}
process.stdout.end(JSON.stringify(result), () => process.exit(0));
