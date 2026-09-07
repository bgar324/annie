import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { z } from "zod";
import type { ConnectionId, RunId, ToolExecutionId, TraceId } from "../core/ids.js";
import type { ModelToolDefinition } from "./model.js";

export type ToolOperationClass = "read" | "write";

export interface ToolExecutionContext {
  runId: RunId;
  traceId: TraceId;
  toolExecutionId: ToolExecutionId;
  connectionId: ConnectionId | null;
  replay: boolean;
  jobLease?: { jobId: string; leaseToken: string };
  signal?: AbortSignal;
}

export interface RegisteredTool {
  definition: ModelToolDefinition;
  operationClass: ToolOperationClass;
  batchMode?: "parallel_read" | "serial";
  execute(argumentsValue: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown>;
}

interface CompiledTool {
  tool: RegisteredTool;
  validate: ValidateFunction;
}

export class ToolRegistryError extends Error {
  readonly code: "unknown_tool" | "invalid_arguments" | "arguments_too_large" | "replay_write_blocked";

  constructor(code: ToolRegistryError["code"], message: string) {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
  }
}

/**
 * Parses tool arguments with the adapter's own schema after JSON-schema validation. The
 * two schemas can disagree at the edges (a strict per-command object behind a flat JSON
 * schema), and a bare ZodError would reach the model as an opaque provider failure. This
 * names the offending paths instead, so the model corrects its next call. Issue messages
 * carry paths and expectations, never argument values.
 */
export function parseToolArguments<T extends z.ZodType>(schema: T, argumentsValue: unknown): z.output<T> {
  const parsed = schema.safeParse(argumentsValue);
  if (parsed.success) {
    return parsed.data;
  }
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length === 0 ? "arguments" : `/${issue.path.join("/")}`}: ${issue.message}`)
    .join("; ");
  throw new ToolRegistryError("invalid_arguments", `Tool arguments do not match the tool schema: ${detail}`);
}

/**
 * Reduces a failed union to the variant the caller was actually aiming at.
 *
 * With `allErrors`, ajv reports every `anyOf` branch, so a tasks query with one bad field
 * came back as the calendar branch's complaints ("must have required property 'timeMin'")
 * and the real fault fell outside the five-issue budget. The model retried the same shape
 * and the read failed twice. A branch that fails on a `const` or `enum` is a variant the
 * discriminator ruled out; among the rest the fewest failures is the closest match.
 */
function branchScopedErrors(errors: readonly ErrorObject[]): readonly ErrorObject[] {
  let kept = [...errors];
  for (const union of errors.filter((error) => error.keyword === "anyOf" || error.keyword === "oneOf")) {
    const prefix = `${union.schemaPath}/`;
    const branches = new Map<string, ErrorObject[]>();
    for (const error of kept) {
      if (!error.schemaPath.startsWith(prefix)) {
        continue;
      }
      const branch = error.schemaPath.slice(prefix.length).split("/")[0] ?? "";
      branches.set(branch, [...(branches.get(branch) ?? []), error]);
    }
    const candidates = [...branches.values()];
    if (candidates.length === 0) {
      kept = kept.filter((error) => error !== union);
      continue;
    }
    const selected = candidates.filter(
      (group) => !group.some((error) => error.keyword === "const" || error.keyword === "enum"),
    );
    const closest = (selected.length > 0 ? selected : candidates).reduce((best, group) =>
      group.length < best.length ? group : best,
    );
    kept = kept.filter(
      (error) => error !== union && (!error.schemaPath.startsWith(prefix) || closest.includes(error)),
    );
  }
  return kept;
}

export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, CompiledTool>;

  constructor(tools: readonly RegisteredTool[]) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const compiled = new Map<string, CompiledTool>();
    for (const tool of tools) {
      const name = tool.definition.name;
      if (!/^[a-z][a-z0-9_.-]{0,127}$/u.test(name)) {
        throw new Error(`Invalid tool name: ${name}`);
      }
      if (compiled.has(name)) {
        throw new Error(`Duplicate tool name: ${name}`);
      }
      compiled.set(name, {
        tool,
        validate: ajv.compile(tool.definition.parameters),
      });
    }
    this.#tools = compiled;
  }

  static empty(): ToolRegistry {
    return new ToolRegistry([]);
  }

  definitions(): readonly ModelToolDefinition[] {
    return [...this.#tools.values()].map(({ tool }) => tool.definition);
  }

  operationClass(name: string): ToolOperationClass {
    return this.#required(name).tool.operationClass;
  }

  canRunInParallel(name: string): boolean {
    const tool = this.#required(name).tool;
    return tool.operationClass === "read" && tool.batchMode === "parallel_read";
  }

  async execute(input: {
    name: string;
    argumentsJson: string;
    context: ToolExecutionContext;
  }): Promise<unknown> {
    const compiled = this.#required(input.name);
    if (Buffer.byteLength(input.argumentsJson) > 65_536) {
      throw new ToolRegistryError("arguments_too_large", "Tool arguments exceed 64 KiB");
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(input.argumentsJson);
    } catch {
      throw new ToolRegistryError("invalid_arguments", "Tool arguments are not valid JSON");
    }
    if (
      argumentsValue === null ||
      typeof argumentsValue !== "object" ||
      Array.isArray(argumentsValue)
    ) {
      throw new ToolRegistryError("invalid_arguments", "Tool arguments must be one JSON object");
    }
    if (!compiled.validate(argumentsValue)) {
      // Name the violations so the model can correct its next call instead of guessing;
      // schema paths and keywords carry no user data. Bounded so a pathological call
      // cannot flood the transcript.
      const detail = branchScopedErrors(compiled.validate.errors ?? [])
        .slice(0, 5)
        .map((error) => {
          const extra = typeof error.params.additionalProperty === "string" ? ` '${error.params.additionalProperty}'` : "";
          return `${error.instancePath === "" ? "arguments" : error.instancePath} ${error.message ?? "is invalid"}${extra}`;
        })
        .join("; ");
      throw new ToolRegistryError("invalid_arguments", `Tool arguments do not match the tool schema: ${detail}`);
    }
    if (input.context.replay && compiled.tool.operationClass === "write") {
      throw new ToolRegistryError("replay_write_blocked", "Replay mode cannot execute provider writes");
    }
    return compiled.tool.execute(argumentsValue as Record<string, unknown>, input.context);
  }

  #required(name: string): CompiledTool {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      throw new ToolRegistryError("unknown_tool", `Unknown tool: ${name}`);
    }
    return tool;
  }
}
