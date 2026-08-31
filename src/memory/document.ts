import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const emptyMemory = "# Memory\n";
const forbiddenMemoryPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:access|refresh)[_-]?token\s*[:=]\s*\S+/iu,
  /\b(?:sk|whsec|ya29)[-_\.][A-Za-z0-9._-]{8,}/u,
  /https?:\/\/\S+\/connect\/(?:google|notion)\?\S*\btoken=/iu,
] as const;

export interface MemoryReplacement {
  content: string;
}

export class MemoryValidationError extends Error {
  readonly code: "invalid_structure" | "too_large" | "forbidden_secret";

  constructor(code: MemoryValidationError["code"], message: string) {
    super(message);
    this.name = "MemoryValidationError";
    this.code = code;
  }
}

export class MemoryDocumentStore {
  readonly #path: string;
  readonly #maximumBytes: number;
  readonly #forbiddenValues: readonly string[];

  constructor(input: {
    path: string;
    maximumBytes: number;
    forbiddenValues?: readonly string[];
  }) {
    this.#path = input.path;
    this.#maximumBytes = input.maximumBytes;
    this.#forbiddenValues = (input.forbiddenValues ?? []).filter((value) => value.length >= 8);
  }

  async repairAndLoad(): Promise<string> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryFiles = await this.#temporaryFiles();
    if (await exists(this.#path)) {
      await this.#removeTemporaryFiles(temporaryFiles);
      return this.load();
    }

    const candidates = await Promise.all(
      temporaryFiles.map(async (path) => ({ path, modifiedAtMs: (await stat(path)).mtimeMs })),
    );
    candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
    for (const candidate of candidates) {
      try {
        const content = normalizeMemory(await readFile(candidate.path, "utf8"));
        this.#validate(content);
        if (Buffer.byteLength(content) <= this.#maximumBytes) {
          await rename(candidate.path, this.#path);
          await fsyncDirectory(directory);
          await this.#removeTemporaryFiles(
            temporaryFiles.filter((path) => path !== candidate.path),
          );
          return content;
        }
      } catch {
        // A stale partial temp file is not authoritative.
      }
    }
    await this.#removeTemporaryFiles(temporaryFiles);
    await this.#atomicWrite(emptyMemory);
    return emptyMemory;
  }

  async load(): Promise<string> {
    const content = normalizeMemory(await readFile(this.#path, "utf8"));
    this.#validate(content);
    if (Buffer.byteLength(content) > this.#maximumBytes) {
      throw new MemoryValidationError("too_large", "The memory document exceeds its configured cap");
    }
    return content;
  }

  prepareReplacement(proposed: string): MemoryReplacement {
    const normalized = normalizeMemory(proposed);
    this.#validate(normalized);
    if (Buffer.byteLength(normalized) > this.#maximumBytes) {
      throw new MemoryValidationError("too_large", "The proposed memory exceeds its configured cap");
    }
    return { content: normalized };
  }

  async replace(proposed: string): Promise<MemoryReplacement> {
    const replacement = this.prepareReplacement(proposed);
    await this.#atomicWrite(replacement.content);
    return replacement;
  }

  async #atomicWrite(content: string): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `${basename(this.#path)}.tmp-${process.pid}-${randomUUID()}`,
    );
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporaryPath, this.#path);
      await fsyncDirectory(directory);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async #temporaryFiles(): Promise<readonly string[]> {
    const directory = dirname(this.#path);
    const prefix = `${basename(this.#path)}.tmp-`;
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
      .map((entry) => join(directory, entry.name));
  }

  async #removeTemporaryFiles(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }

  #validate(content: string): void {
    const lines = content.split("\n");
    if (lines[0] !== "# Memory" || lines.slice(1).some((line) => line.startsWith("# "))) {
      throw new MemoryValidationError(
        "invalid_structure",
        "Memory must contain exactly one top-level '# Memory' heading",
      );
    }
    if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content)) {
      throw new MemoryValidationError("invalid_structure", "Memory contains control characters");
    }
    if (forbiddenMemoryPatterns.some((pattern) => pattern.test(content))) {
      throw new MemoryValidationError("forbidden_secret", "Memory contains credential-like content");
    }
    for (const value of this.#forbiddenValues) {
      if (content.includes(value)) {
        throw new MemoryValidationError("forbidden_secret", "Memory contains a configured secret");
      }
    }
  }
}

function normalizeMemory(value: string): string {
  return `${value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd()}\n`;
}


async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
