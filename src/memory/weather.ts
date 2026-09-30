import { MemoryValidationError } from "./document.js";

const dailyBriefWeatherCityPrefix = "- Daily brief weather city:";

export function readDailyBriefWeatherCity(memory: string): string | undefined {
  let city: string | undefined;
  for (const line of memory.split(/\r?\n/u)) {
    if (!line.startsWith(dailyBriefWeatherCityPrefix)) {
      continue;
    }
    const value = line.slice(dailyBriefWeatherCityPrefix.length);
    const trimmed = value.trim();
    if (
      city !== undefined ||
      !value.startsWith(" ") ||
      trimmed.length === 0 ||
      trimmed.length > 120 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
    ) {
      throw new MemoryValidationError(
        "invalid_structure",
        "Daily brief weather city must be one nonempty canonical line of at most 120 characters without controls",
      );
    }
    city = trimmed;
  }
  return city;
}
