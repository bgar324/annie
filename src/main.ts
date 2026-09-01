import { loadLocalEnv, loadLocalUiConfig, loadRuntimeConfig } from "./config.js";
import { runAssistantProcess, type RuntimeListener } from "./lifecycle.js";
import { createLocalUiApp } from "./local-ui/server.js";
import { createRuntime } from "./runtime.js";

loadLocalEnv();
const config = loadRuntimeConfig();
const localUiConfig = loadLocalUiConfig(config);
const runtime = await createRuntime(config);
const listeners: RuntimeListener[] = [
  {
    name: "public",
    app: runtime.app,
    host: config.host,
    port: config.port,
  },
];

if (localUiConfig !== undefined) {
  listeners.push({
    name: "local_ui",
    app: createLocalUiApp({
      config: localUiConfig,
      publicBaseUrl: config.publicBaseUrl,
      memoryMaximumBytes: config.limits.memoryMaxBytes,
      connections: runtime.localUi.connections,
      links: runtime.localUi.links,
      memory: runtime.localUi.memory,
      traces: runtime.traces,
      isReady: runtime.isReady,
    }),
    host: localUiConfig.host,
    port: localUiConfig.port,
  });
}

await runAssistantProcess({ runtime, listeners });
