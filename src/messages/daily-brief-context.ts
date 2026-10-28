import type { ConnectionRecord } from "../connections/types.js";
import type { ConnectionId } from "../core/ids.js";

export interface DailyBriefWindow {
  calendarStart: string;
  calendarEnd: string;
  modifiedAfter: string;
}
export type DailyFacet = "gmail" | "calendar" | "drive" | "tasks" | "notion";
export interface DailySourceFacet {
  connectionId: ConnectionId;
  provider: "google" | "notion";
  safeLabel: string;
  facet: DailyFacet;
}

export function dailyBriefWindow(scheduledForMs: number, nextMorningMs: number): DailyBriefWindow {
  return {
    calendarStart: new Date(scheduledForMs).toISOString(),
    calendarEnd: new Date(nextMorningMs).toISOString(),
    modifiedAfter: new Date(scheduledForMs - 24 * 60 * 60 * 1_000).toISOString(),
  };
}
export function dailyBriefSources(connections: readonly ConnectionRecord[]): readonly DailySourceFacet[] {
  const sources: DailySourceFacet[] = [];
  for (const connection of connections) {
    if (connection.status !== "healthy") {
      continue;
    }
    if (connection.provider === "notion") {
      if (connection.capabilities.includes("notion.search")) {
        sources.push({
          connectionId: connection.id,
          provider: "notion",
          safeLabel: connection.safeLabel,
          facet: "notion",
        });
      }
      continue;
    }
    for (const [capability, facet] of [
      ["gmail.read", "gmail"],
      ["calendar.read", "calendar"],
      ["drive.read", "drive"],
      ["tasks.read", "tasks"],
    ] as const) {
      if (connection.capabilities.includes(capability)) {
        sources.push({
          connectionId: connection.id,
          provider: "google",
          safeLabel: connection.safeLabel,
          facet,
        });
      }
    }
  }
  return sources;
}

export function searchCoverage(
  toolName: string,
  argumentsJson: string,
  window: DailyBriefWindow,
): { label: string; facets: readonly DailyFacet[] } | undefined {
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const input = value as Record<string, unknown>;
    if (toolName === "gmail.search") {
      return typeof input.account === "string"
        ? { label: input.account, facets: ["gmail"] }
        : undefined;
    }
    if (toolName === "notion.search") {
      return typeof input.workspace === "string"
        ? { label: input.workspace, facets: ["notion"] }
        : undefined;
    }
    if (toolName !== "google.search" || typeof input.account !== "string" || !Array.isArray(input.queries)) {
      return undefined;
    }
    const facets = new Set<DailyFacet>();
    for (const query of input.queries) {
      if (query === null || typeof query !== "object" || Array.isArray(query)) {
        return undefined;
      }
      const input = query as Record<string, unknown>;
      const product = input.product;
      if (
        product === "calendar" &&
        input.timeMin === window.calendarStart &&
        input.timeMax === window.calendarEnd &&
        input.query === undefined &&
        input.maxResults === 20
      ) {
        facets.add("calendar");
      } else if (
        product === "drive" &&
        input.text === undefined &&
        input.modifiedAfter === window.modifiedAfter &&
        input.modifiedBefore === undefined &&
        input.maxResults === 20
      ) {
        facets.add("drive");
      } else if (
        product === "tasks" &&
        input.query === undefined &&
        input.dueBefore === window.calendarEnd &&
        input.includeCompleted === false &&
        input.maxResults === 20
      ) {
        facets.add("tasks");
      }
    }
    return { label: input.account, facets: [...facets] };
  } catch {
    return undefined;
  }
}
