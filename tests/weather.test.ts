import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunId, newToolExecutionId, newTraceId } from "../src/core/ids.js";
import { runMigrations } from "../src/db/migrations.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { fetchDailyWeather, weatherTool } from "../src/messages/weather.js";
import { NwsPointCache } from "../src/messages/weather-cache.js";
import { weatherFailureMessage } from "../src/messages/weather-failure.js";
import type { ProviderFetch } from "../src/providers/fetch.js";
import { createTraceRedactor } from "../src/tracing/redaction.js";
import { TraceStore } from "../src/tracing/store.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
const readWeather = (fetchImpl: ProviderFetch, city?: string, pointCache?: NwsPointCache) => fetchDailyWeather({
  traceId: newTraceId(), traces: traces(), signal: AbortSignal.timeout(12_000), fetchImpl,
  ...(city === undefined ? {} : { city }),
  ...(pointCache === undefined ? {} : { pointCache }),
});

describe("global weather reader", () => {
  it.each([undefined, "Westwood", "UCLA", "Westwood, Los Angeles"])("reads %s independently of Open-Meteo quotas", async (city) => {
    const periods = [
      { startTime: "2026-09-30T06:00:00-07:00", endTime: "2026-09-30T18:00:00-07:00", isDaytime: true, temperature: 82, temperatureUnit: "F", shortForecast: "Partly cloudy" },
      { startTime: "2026-09-30T18:00:00-07:00", endTime: "2026-10-01T06:00:00-07:00", isDaytime: false, temperature: 61, temperatureUnit: "F", shortForecast: "Mostly clear" },
    ];
    const result = await readWeather(async (input) => {
      const url = new URL(new Request(input).url);
      if (url.hostname !== "api.weather.gov") return Response.json({ error: true }, { status: 429 });
      if (url.pathname === "/points/34.0689,-118.4452") {
        return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/LOX/148,47/forecast" } });
      }
      expect(url.href).toBe("https://api.weather.gov/gridpoints/LOX/148,47/forecast?units=us");
      return Response.json({ properties: { periods } });
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
    expect(await readWeather(async (input) => {
      if (new URL(new Request(input).url).hostname === "geocoding-api.open-meteo.com") {
        return Response.json({ results: [{ name: "Tokyo", country: "Japan", latitude: 35.6895, longitude: 139.69171 }] });
      }
      return Response.json(response);
    }, "Tokyo"))
      .toMatchObject({ location: "Tokyo, Japan", error: "weather_unavailable" });
  });

  it("reports provider failure without inventing a forecast", async () => {
    expect(await readWeather(async () => new Response("", { status: 503 })))
      .toMatchObject({ location: "Westwood, Los Angeles", error: "weather_unavailable" });
  });

  it.each(["http://api.weather.gov/gridpoints/LOX/148,47/forecast", "https://example.test/forecast"])("rejects an unsafe NWS forecast URL %s", async (forecast) => {
    let calls = 0;
    expect(await readWeather(async () => {
      calls += 1;
      return Response.json({ properties: { forecast } });
    })).toMatchObject({ location: "Westwood, Los Angeles", error: "weather_unavailable" });
    expect(calls).toBe(1);
  });

  it.each(["empty", "wrong units", "invalid timestamp"])("rejects %s NWS periods", async (problem) => {
    const periods = problem === "empty" ? [] : [{
      startTime: problem === "invalid timestamp" ? "yesterday" : "2026-09-30T18:00:00-07:00",
      endTime: "2026-10-01T06:00:00-07:00", isDaytime: false, temperature: 61,
      temperatureUnit: problem === "wrong units" ? "C" : "F", shortForecast: "Clear",
    }];
    expect(await readWeather(async (input) => {
      if (new URL(new Request(input).url).pathname.startsWith("/points/")) {
        return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/LOX/148,47/forecast" } });
      }
      return Response.json({ properties: { periods } });
    })).toMatchObject({ location: "Westwood, Los Angeles", error: "weather_unavailable" });
  });

  it("preserves a night-only forecast without inventing a daytime high", async () => {
    const periods = [{
      startTime: "2026-09-30T20:00:00-07:00", endTime: "2026-10-01T06:00:00-07:00",
      isDaytime: false, temperature: 61, temperatureUnit: "F", shortForecast: "Clear",
    }];
    expect(await readWeather(async (input) => {
      if (new URL(new Request(input).url).pathname.startsWith("/points/")) {
        return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/LOX/148,47/forecast" } });
      }
      return Response.json({ properties: { periods } });
    })).toEqual({
      location: "Westwood, Los Angeles", timeZone: "America/Los_Angeles",
      days: [{ date: "2026-09-30", highF: null, lowF: 61, condition: "Clear" }],
    });
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

  it("recovers a transient forecast read without repeating the successful point lookup", async () => {
    let forecastAttempts = 0;
    const paths: string[] = [];
    const result = await readWeather(async (request) => {
      const path = new URL(new Request(request).url).pathname;
      paths.push(path);
      if (path.startsWith("/points/")) return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/LOX/148,47/forecast" } });
      if (++forecastAttempts === 1) return new Response("", { status: 503 });
      return Response.json({ properties: { periods: [{
        startTime: "2026-11-02T06:00:00-08:00", endTime: "2026-11-02T18:00:00-08:00",
        isDaytime: true, temperature: 72, temperatureUnit: "F", shortForecast: "Sunny",
      }] } });
    });
    expect(result).toMatchObject({ days: [{ highF: 72, lowF: null, condition: "Sunny" }] });
    expect(paths).toEqual(["/points/34.0689,-118.4452", "/gridpoints/LOX/148,47/forecast", "/gridpoints/LOX/148,47/forecast"]);
  });

  it("keeps a single validated mapping through database restart and revalidates after seven days", async () => {
    const directory = mkdtempSync(join(tmpdir(), "annie-weather-cache-"));
    directories.push(directory);
    const path = join(directory, "weather.sqlite");
    let db = new Database(path);
    runMigrations(db);
    let cache = new NwsPointCache(db);
    const now = Date.now();
    cache.write("https://api.weather.gov/gridpoints/LOX/148,47/forecast", now);
    db.close();
    db = new Database(path);
    databases.push(db);
    cache = new NwsPointCache(db);
    expect(cache.read(now + 1)).toBe("https://api.weather.gov/gridpoints/LOX/148,47/forecast");
    expect(cache.read(now - 1)).toBeUndefined();
    expect(cache.read(now + 7 * 24 * 60 * 60 * 1_000)).toBeUndefined();
    expect(() => cache.write("https://foreign.example.test/forecast", now)).toThrow();
    const paths: string[] = [];
    await readWeather(async (request) => {
      expect(db.inTransaction).toBe(false);
      const url = new URL(new Request(request).url);
      paths.push(url.pathname);
      if (paths.length === 1) return new Response("", { status: 404 });
      if (url.pathname.startsWith("/points/")) return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/LOX/149,48/forecast" } });
      return Response.json({ properties: { periods: [{
        startTime: "2026-11-02T18:00:00-08:00", endTime: "2026-11-03T06:00:00-08:00",
        isDaytime: false, temperature: 56, temperatureUnit: "F", shortForecast: "Clear",
      }] } });
    }, undefined, cache);
    expect(paths).toEqual(["/gridpoints/LOX/148,47/forecast", "/points/34.0689,-118.4452", "/gridpoints/LOX/149,48/forecast"]);
    expect(cache.read(Date.now())).toBe("https://api.weather.gov/gridpoints/LOX/149,48/forecast");
    expect(db.prepare("SELECT COUNT(*) AS count FROM nws_campus_mapping").get()).toEqual({ count: 1 });
  });

  it("reports safe validation paths without retrying invalid data or exposing its payload", async () => {
    let requests = 0;
    const result = await readWeather(async () => {
      requests += 1;
      return Response.json({ properties: { forecast: "https://foreign.example.test/?token=test-secret" } });
    });
    expect(requests).toBe(1);
    expect(result).toMatchObject({
      error: "weather_unavailable",
      diagnostics: { requests: 1, failures: [{ provider: "nws", stage: "points", kind: "invalid_response", httpStatus: 200,
        issues: [{ path: "properties.forecast", code: "invalid_format" }] }] },
    });
    const message = weatherFailureMessage(result);
    expect(message).toContain("properties.forecast");
    expect(message).not.toContain("test-secret");
    expect(message).not.toContain("foreign.example.test");
  });

  it("honors rate-limit Retry-After without sleeping past the total weather budget", async () => {
    let requests = 0;
    const result = await readWeather(async () => {
      requests += 1;
      return new Response("", { status: 429, headers: { "retry-after": "60" } });
    });
    expect(requests).toBe(1);
    expect(result).toMatchObject({ diagnostics: { failures: [{ kind: "http", httpStatus: 429 }] } });
  });

  it("never retries a transient read after caller cancellation", async () => {
    const controller = new AbortController();
    let requests = 0;
    const pending = fetchDailyWeather({
      traceId: newTraceId(), traces: traces(), signal: controller.signal,
      fetchImpl: async () => {
        requests += 1;
        controller.abort(new Error("lease lost"));
        return new Response("", { status: 503 });
      },
    });
    await expect(pending).rejects.toThrow("lease lost");
    expect(requests).toBe(1);
  });
});
