import { z } from "zod";

const failureDetailSchema = z.object({
  provider: z.enum(["nws", "open_meteo"]),
  stage: z.enum(["points", "forecast", "geocoding"]),
  kind: z.enum(["http", "timeout", "network", "invalid_response"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  issues: z.array(z.object({
    path: z.string().max(96).regex(/^[a-zA-Z0-9_.]*$/u),
    code: z.string().max(40).regex(/^[a-z_]+$/u),
  })).max(3),
});
export const weatherFailureDiagnosticsSchema = z.object({
  elapsedMs: z.number().int().nonnegative(),
  requests: z.number().int().min(0).max(8),
  failures: z.array(failureDetailSchema).min(1).max(8),
});
export type WeatherFailureDetail = z.infer<typeof failureDetailSchema>;
export type WeatherFailureDiagnostics = z.infer<typeof weatherFailureDiagnosticsSchema>;

/** Only allowlisted fields cross from persisted weather data into the message. */
export function weatherFailureMessage(weather: unknown): string | undefined {
  const parsed = z.object({
    error: z.literal("weather_unavailable"),
    diagnostics: weatherFailureDiagnosticsSchema,
  }).safeParse(weather);
  return parsed.success ? `Weather failure details: ${JSON.stringify(parsed.data.diagnostics)}` : undefined;
}
