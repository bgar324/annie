import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const benVolume = volume("ben-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "ams", sizeMB: 500 });
  const ben = service("ben", {
    source: github("bgar324/annie", { checkSuites: false }),
    replicas: { "ams": 1 },
    healthcheck: "/health",
    healthcheckTimeout: 30,
    volumeMounts: { "/app/data": benVolume },
    env: { CREDENTIAL_ENCRYPTION_KEY: preserve(), DAILY_BRIEF_ENABLED: preserve(), GEMINI_API_KEY: preserve(), GEMINI_BASE_URL: preserve(), GEMINI_MODEL: preserve(), GEMINI_REASONING_EFFORT: preserve(), GOOGLE_CLIENT_ID: preserve(), GOOGLE_CLIENT_SECRET: preserve(), LOG_LEVEL: preserve(), NODE_ENV: preserve(), NOTION_MCP_URL: preserve(), PUBLIC_BASE_URL: preserve(), RAILWAY_DEPLOYMENT_DRAINING_SECONDS: preserve(), SENDBLUE_API_KEY_ID: preserve(), SENDBLUE_API_SECRET_KEY: preserve(), SENDBLUE_BASE_URL: preserve(), SENDBLUE_FROM_NUMBER: preserve(), USER_PHONE_NUMBER: preserve() },
  });

  return project("ben", {
    resources: [ben, benVolume],
  });
});
