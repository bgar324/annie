import type Database from "better-sqlite3";
import { z } from "zod";

export const nwsForecastUrlSchema = z.string().regex(/^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3}\/\d+,\d+\/forecast$/u);
const mappingLifetimeMs = 7 * 24 * 60 * 60 * 1_000;

/** One campus mapping, not forecast data. Persists through process sleep/restarts. */
export class NwsPointCache {
  constructor(private readonly db: Database.Database) {}

  read(nowMs: number): string | undefined {
    const row = this.db.prepare<[], { forecast_url: string; checked_at_ms: number }>(
      "SELECT forecast_url, checked_at_ms FROM nws_campus_mapping WHERE id = 1",
    ).get();
    if (row === undefined || row.checked_at_ms > nowMs || nowMs - row.checked_at_ms >= mappingLifetimeMs) return undefined;
    const parsed = nwsForecastUrlSchema.safeParse(row.forecast_url);
    return parsed.success ? parsed.data : undefined;
  }

  write(forecastUrl: string, nowMs: number): void {
    const url = nwsForecastUrlSchema.parse(forecastUrl);
    this.db.prepare(`
      INSERT INTO nws_campus_mapping(id, forecast_url, checked_at_ms) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET forecast_url = excluded.forecast_url, checked_at_ms = excluded.checked_at_ms
    `).run(url, nowMs);
  }

  clear(): void {
    this.db.prepare("DELETE FROM nws_campus_mapping WHERE id = 1").run();
  }
}
