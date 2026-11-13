import { createHash } from "node:crypto";

const passwordPadding = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);

/** Builds a real, deterministic PDF with one array of text lines per page. */
export function createPdf(pages: readonly (readonly string[])[]): Uint8Array {
  return buildPdf(pages);
}

/** A real Standard Security revision-2 document, password "secret". */
export function createEncryptedPdf(): Uint8Array {
  return buildPdf([["Private synthetic policy"]], true);
}

/** A readable stream followed by a broken compressed stream on the same page. */
export function createCorruptPdf(): Uint8Array {
  return buildPdf([["Readable synthetic prefix"]], false, true);
}

function buildPdf(pages: readonly (readonly string[])[], encrypted = false, corruptSecondStream = false): Uint8Array {
  const objects: Buffer[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  const encryptId = 4 + pages.length * 2;
  const documentId = Buffer.alloc(16, 0x42);
  const owner = rc4(md5(paddedPassword("owner")).subarray(0, 5), paddedPassword("secret"));
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([paddedPassword("secret"), owner, permissions, documentId])).subarray(0, 5);
  const add = (value: string | Buffer) => objects.push(typeof value === "string" ? Buffer.from(value, "ascii") : value);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  for (const [index, lines] of pages.entries()) {
    const pageId = 4 + index * 2;
    const streamId = pageId + 1;
    const contents = corruptSecondStream && index === 0
      ? `[${streamId} 0 R ${4 + pages.length * 2} 0 R]`
      : `${streamId} 0 R`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} >>`);
    // Keep even boundary-size synthetic text inside the page instead of testing clipping.
    const fontSize = Math.min(12, 500 / Math.max(1, ...lines.map((line) => line.length)));
    let stream: Buffer = Buffer.from(
      `BT /F1 ${fontSize} Tf 14 TL 50 740 Td\n${lines.map((line, lineIndex) => `${lineIndex ? "T* " : ""}(${pdfString(line)}) Tj`).join("\n")}\nET`,
      "ascii",
    );
    if (encrypted) {
      const objectNumber = Buffer.from([streamId & 255, (streamId >> 8) & 255, (streamId >> 16) & 255, 0, 0]);
      stream = rc4(md5(Buffer.concat([key, objectNumber])).subarray(0, 10), stream);
    }
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  }
  if (corruptSecondStream) {
    const damaged = Buffer.from("corrupt synthetic compressed content");
    add(Buffer.concat([Buffer.from(`<< /Length ${damaged.length} /Filter /FlateDecode >>\nstream\n`), damaged, Buffer.from("\nendstream")]));
  }
  if (encrypted) {
    add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${rc4(key, passwordPadding).toString("hex")}> /P -4 >>`);
  }
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = chunks[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const trailer = encrypted
    ? ` /Encrypt ${encryptId} 0 R /ID [<${documentId.toString("hex")}> <${documentId.toString("hex")}>]`
    : "";
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function pdfString(text: string): string {
  return Array.from(text, (character) => {
    if (character === "\\" || character === "(" || character === ")") return `\\${character}`;
    const code = character === "€" ? 128 : character.charCodeAt(0);
    if (code > 255) throw new Error("Synthetic PDF text must fit WinAnsi encoding");
    return code < 32 || code > 126 ? `\\${code.toString(8).padStart(3, "0")}` : character;
  }).join("");
}

function paddedPassword(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, "ascii"), passwordPadding]).subarray(0, 32);
}

function md5(bytes: Uint8Array): Buffer {
  return createHash("md5").update(bytes).digest();
}

function rc4(key: Uint8Array, input: Uint8Array): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  const result = Buffer.alloc(input.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < input.length; index++) {
    i = (i + 1) & 255;
    j = (j + state[i]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
    result[index] = input[index]! ^ state[(state[i]! + state[j]!) & 255]!;
  }
  return result;
}
