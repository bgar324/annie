import { z } from "zod";

export const PDF_MAX_BYTES = 5 * 1024 * 1024;
export const PDF_MAX_PAGES = 40;
export const PDF_MAX_TEXT_BYTES = 32_768;
export const PDF_TIMEOUT_MS = 5_000;

export const pdfUnavailableMessages = {
  encrypted: "This PDF is password protected; its contents were not read.",
  invalid_pdf: "This attachment could not be read as a valid PDF.",
  incomplete_pdf: "This PDF contains damaged or unsupported content; complete text extraction could not be confirmed.",
  no_extractable_text: "This PDF has no extractable text. Scanned pages require OCR, which is not supported.",
  too_many_pages: "This PDF exceeds the 40-page reading limit; its contents were not read.",
  parser_limit: "PDF extraction exceeded its safety limits or the parser could not finish; its contents were not read.",
} as const;

export const pdfTextResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("read"),
    text: z.string().min(1).refine((text) => Buffer.byteLength(text, "utf8") <= PDF_MAX_TEXT_BYTES),
    pages: z.number().int().min(1).max(PDF_MAX_PAGES),
    pagesRead: z.number().int().min(0).max(PDF_MAX_PAGES),
    pagesWithoutText: z.array(z.number().int().min(1).max(PDF_MAX_PAGES)).max(PDF_MAX_PAGES),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum(["encrypted", "invalid_pdf", "incomplete_pdf", "no_extractable_text", "too_many_pages", "parser_limit"]),
    message: z.string().max(256),
  }).strict(),
]);

export type PdfTextResult = z.infer<typeof pdfTextResultSchema>;
