import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { newRunId, newToolExecutionId, newTraceId } from "../src/core/ids.js";
import { runMigrations } from "../src/db/migrations.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { fetchDailyWeather, weatherTool } from "../src/messages/weather.js";
import type { ProviderFetch } from "../src/providers/fetch.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function traces(): TraceStore {
  const db = new Database(":memory:");
  runMigrations(db);
  databases.push(db);
  return new TraceStore(db, createTraceRedactor([]));
}
function forecast(timezone = "America/Los_Angeles") {
  return {
    timezone,
    daily_units: { time: "iso8601", temperature_2m_max: "°F", temperature_2m_min: "°F", weather_code: "wmo code" },
    daily: { time: ["2026-09-30"], temperature_2m_max: [82], temperature_2m_min: [61], weather_code: [2] },
  };
}
const readWeather = (fetchImpl: ProviderFetch, city?: string) => fetchDailyWeather({
  traceId: newTraceId(), traces: traces(), signal: AbortSignal.timeout(5_000), fetchImpl,
  ...(city === undefined ? {} : { city }),
});

describe("global weather reader", () => {
  it.each([undefined, "Westwood", "UCLA", "Westwood, Los Angeles"])("uses UCLA coordinates for %s", async (city) => {
    const result = await readWeather(async (input) => {
      const url = new URL(new Request(input).url);
      expect(url.origin).toBe("https://api.open-meteo.com");
      expect(url.searchParams.get("latitude")).toBe("34.0689");
      expect(url.searchParams.get("longitude")).toBe("-118.4452");
      expect(url.searchParams.get("temperature_unit")).toBe("fahrenheit");
      return Response.json(forecast());
    }, city);
    expect(result).toEqual({
      location: "Westwood, Los Angeles", timeZone: "America/Los_Angeles",
      days: [{ date: "2026-09-30", highF: 82, lowF: 61, condition: "Partly cloudy" }],
    });
  });

  it.each([
    { city: "West Covina, California", name: "West Covina", admin1: "California", country: "United States", latitude: 34.06862, longitude: -117.93895, timezone: "America/Los_Angeles", label: "West Covina, California, United States" },
    { city: "Tokyo, Japan", name: "Tokyo", admin1: "Tokyo", country: "Japan", latitude: 35.6895, longitude: 139.69171, timezone: "Asia/Tokyo", label: "Tokyo, Japan" },
  ])("resolves $city without falling back to Westwood", async (place) => {
    const requests: string[] = [];
    const result = await readWeather(async (input) => {
      const url = new URL(new Request(input).url);
      requests.push(url.hostname);
      if (url.hostname === "geocoding-api.open-meteo.com") {
        expect(url.searchParams.get("name")).toBe(place.city);
        return Response.json({ results: [place, { ...place, name: `${place.name} Airport`, longitude: place.longitude + 0.1 }] });
      }
      expect(url.hostname).toBe("api.open-meteo.com");
      expect(url.searchParams.get("latitude")).toBe(String(place.latitude));
      expect(url.searchParams.get("longitude")).toBe(String(place.longitude));
      return Response.json(forecast(place.timezone));
    }, place.city);
    expect(requests).toEqual(["geocoding-api.open-meteo.com", "api.open-meteo.com"]);
    expect(result).toMatchObject({ location: place.label, timeZone: place.timezone, days: [{ date: "2026-09-30", highF: 82, lowF: 61 }] });
  });

  it("asks for clarification before reading weather for an ambiguous city", async () => {
    let requests = 0;
    const result = await readWeather(async () => {
      requests += 1;
      return Response.json({ results: [
        { name: "Springfield", admin1: "Illinois", country: "United States", latitude: 39.8, longitude: -89.65 },
        { name: "Springfield", admin1: "Massachusetts", country: "United States", latitude: 42.1, longitude: -72.59 },
      ] });
    }, "Springfield");
    expect(result).toEqual({ location: "Springfield", error: "location_ambiguous", candidates: ["Springfield, Illinois, United States", "Springfield, Massachusetts, United States"] });
    expect(requests).toBe(1);
  });

  it("does not substitute the default for an unknown city", async () => {
    expect(await readWeather(async () => Response.json({ results: [] }), "NoSuchCity123"))
      .toEqual({ location: "NoSuchCity123", error: "location_not_found" });
  });

  it.each(["mismatched days", "wrong units", "unknown condition", "invalid date", "invalid timezone", "high below low"])("rejects a forecast with %s", async (problem) => {
    const response = forecast();
    if (problem === "mismatched days") response.daily.temperature_2m_min = [];
    if (problem === "wrong units") response.daily_units.temperature_2m_max = "°C";
    if (problem === "unknown condition") response.daily.weather_code = [999];
    if (problem === "invalid date") response.daily.time = ["2026-02-30"];
    if (problem === "invalid timezone") response.timezone = "Not/AZone";
    if (problem === "high below low") response.daily.temperature_2m_max = [20];
    expect(await readWeather(async () => Response.json(response)))
      .toEqual({ location: "Westwood, Los Angeles", error: "weather_unavailable" });
  });

  it("reports provider failure without inventing a forecast", async () => {
    expect(await readWeather(async () => new Response("", { status: 503 })))
      .toEqual({ location: "Westwood, Los Angeles", error: "weather_unavailable" });
  });

  it("propagates caller cancellation before requesting the resolved forecast", async () => {
    const controller = new AbortController();
    let requests = 0;
    await expect(fetchDailyWeather({
      city: "Tokyo, Japan", traceId: newTraceId(), traces: traces(), signal: controller.signal,
      fetchImpl: async () => {
        requests += 1;
        controller.abort(new Error("lease lost"));
        return Response.json({ results: [] });
      },
    })).rejects.toThrow("lease lost");
    expect(requests).toBe(1);
  });

  it("rejects empty city input before network access", async () => {
    let requests = 0;
    const registry = new ToolRegistry([weatherTool({ traces: traces(), fetchImpl: async () => {
      requests += 1;
      return Response.json(forecast());
    } })]);
    await expect(registry.execute({ name: "weather.get", argumentsJson: '{"city":"  "}', context: {
      runId: newRunId(), traceId: newTraceId(), toolExecutionId: newToolExecutionId(), connectionId: null, replay: false,
    } })).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(requests).toBe(0);
  });
});
