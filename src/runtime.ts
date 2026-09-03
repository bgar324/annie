import fastify, { type FastifyInstance } from "fastify";
import { AgentLoop } from "./agent/loop.js";
import { DeepSeekChatModel } from "./agent/deepseek.js";
import { ConversationHistoryStore } from "./agent/history.js";
import type { ChatModel, MemoryMaintenanceModel } from "./agent/model.js";
import { AgentRunStore } from "./agent/store.js";
import { ToolRegistry } from "./agent/tools.js";
import type { RuntimeConfig } from "./config.js";
import { RefreshCoordinator } from "./connections/refresh.js";
import { ConnectionRecoveryService } from "./connections/recovery.js";
import { ConnectionRouter } from "./connections/router.js";
import { ConnectionStore } from "./connections/store.js";
import { connectionTools } from "./connections/tools.js";
import { asEgressId, asRunId } from "./core/ids.js";
import { openDatabase, type DatabaseHandle } from "./db/database.js";
import type { GmailClientProvider } from "./gmail/client.js";
import { GoogleGmailClientProvider } from "./gmail/client.js";
import { GmailToolService } from "./gmail/tools.js";
import type { GoogleWorkspaceClientProvider } from "./google/client.js";
import { GoogleApisWorkspaceClientProvider } from "./google/client.js";
import { GoogleWorkspaceToolService } from "./google/tools.js";
import { MemoryDocumentStore } from "./memory/document.js";
import { MemoryMaintenanceService } from "./memory/maintenance.js";
import { SendblueGateway } from "./messages/client.js";
import { DailyBriefService } from "./messages/daily-brief.js";
import { MessageEgressService, type EgressSendPolicy } from "./messages/egress.js";
import { FailureNotificationService } from "./messages/failure.js";
import { MessageIngressService } from "./messages/inbound.js";
import { SendblueReceiver } from "./messages/receiver.js";
import { InboundTurnService } from "./messages/turn.js";
import {
  MessagingProviderError,
  type MessageGateway,
} from "./messages/types.js";
import type { NotionClientProvider } from "./notion/client.js";
import { HostedNotionClientProvider } from "./notion/client.js";
import { NotionToolService } from "./notion/tools.js";
import { OAuthAttemptStore } from "./oauth/attempts.js";
import { registerGoogleOAuth } from "./oauth/google.js";
import { ConnectLinkService } from "./oauth/links.js";
import { registerNotionOAuth } from "./oauth/notion.js";
import { QueueStore } from "./queue/store.js";
import {
  DurableWorker,
  RetryableJobError,
  type JobHandlers,
} from "./queue/worker.js";
import { CredentialVault } from "./security/vault.js";
import { TraceProjector } from "./tracing/jsonl.js";
import { createTraceRedactor } from "./tracing/redaction.js";
import { TraceRetentionService } from "./tracing/retention.js";
import { TraceStore } from "./tracing/store.js";
import { WriteStore } from "./writes/store.js";

const memoryMaintenanceBudgetMs = 45_000;
const memoryMaintenanceLeaseMarginMs = 5_000;

export interface AssistantModel extends ChatModel, MemoryMaintenanceModel {}

export interface RuntimeOverrides {
  model?: AssistantModel;
  messageGateway?: MessageGateway;
  gmailClients?: GmailClientProvider;
  googleWorkspaceClients?: GoogleWorkspaceClientProvider;
  notionClients?: NotionClientProvider;
  logger?: false;
}

export interface LocalUiServices {
  readonly connections: ConnectionStore;
  readonly links: ConnectLinkService;
  readonly memory: MemoryDocumentStore;
}

export interface AssistantRuntime {
  app: FastifyInstance;
  database: DatabaseHandle;
  worker: DurableWorker;
  receiver: SendblueReceiver;
  dailyBrief: DailyBriefService;
  handlers: JobHandlers;
  queue: QueueStore;
  traces: TraceStore;
  projector: TraceProjector;
  tools: ToolRegistry;
  localUi: LocalUiServices;
  isReady(): boolean;
  setReady(value: boolean): void;
  close(): Promise<void>;
}

export async function createRuntime(
  config: RuntimeConfig,
  overrides: RuntimeOverrides = {},
): Promise<AssistantRuntime> {
  const database = openDatabase(config);
  try {
    const traces = new TraceStore(database.db, createTraceRedactor(config.secretValues));
    const projector = new TraceProjector(database.db, traces, config.traceDir);
    const queue = new QueueStore({
      db: database.db,
      traces,
      leaseMs: config.limits.jobLeaseMs,
      maxPending: config.limits.maxPendingJobs,
    });
    const writes = new WriteStore(database.db, traces);
    const messages = overrides.messageGateway ?? new SendblueGateway(config);
    const egress = new MessageEgressService({
      db: database.db,
      gateway: messages,
      queue,
      traces,
      writes,
      lineNumber: config.sendblue.fromNumber,
    });
    const vault = new CredentialVault(config.credentialEncryptionKey);
    const connections = new ConnectionStore(database.db, vault, traces);
    const links = new ConnectLinkService({
      db: database.db,
      signingKey: vault.linkSigningKey(),
      publicBaseUrl: config.publicBaseUrl,
      traces,
      ttlMs: config.limits.oauthLinkTtlMs,
    });
    const attempts = new OAuthAttemptStore({ db: database.db, links, vault, traces });
    const recovery = new ConnectionRecoveryService({
      db: database.db,
      config,
      connections,
      links,
      egress,
      queue,
    });
    const refresh = new RefreshCoordinator({
      db: database.db,
      config,
      connections,
      traces,
      recovery,
    });
    const router = new ConnectionRouter(connections);
    const runs = new AgentRunStore(database.db, traces);
    const gmail = new GmailToolService({
      router,
      connections,
      clients: overrides.gmailClients ?? new GoogleGmailClientProvider(config, refresh),
      runs,
      traces,
    });
    const workspace = new GoogleWorkspaceToolService({
      router,
      connections,
      clients:
        overrides.googleWorkspaceClients ??
        new GoogleApisWorkspaceClientProvider(config, refresh),
      runs,
      traces,
    });
    const notion = new NotionToolService({
      db: database.db,
      router,
      connections,
      clients:
        overrides.notionClients ??
        new HostedNotionClientProvider(config, refresh, traces),
      runs,
      writes,
    });
    const providerTools = [...gmail.tools(), ...workspace.tools(), ...notion.tools()];
    const tools = new ToolRegistry(providerTools);
    assertProductionTools(tools);
    const agentTools = new ToolRegistry([...providerTools, ...connectionTools(connections)]);
    assertAgentTools(agentTools, tools);
    const model = overrides.model ?? new DeepSeekChatModel({ config, traces });
    const agentLimits = {
      maxToolRounds: config.limits.maxAgentToolRounds,
      maxToolCalls: config.limits.maxAgentToolCalls,
      maxProviderWrites: config.limits.maxAgentWrites,
      maxRunMs: config.limits.maxAgentRunMs,
    };
    const agent = new AgentLoop({ model, tools: agentTools, runs, writes, limits: agentLimits });
    const memory = new MemoryDocumentStore({
      path: config.memoryPath,
      maximumBytes: config.limits.memoryMaxBytes,
      forbiddenValues: config.secretValues,
    });
    await memory.repairAndLoad();
    const maintenance = new MemoryMaintenanceService({
      db: database.db,
      documents: memory,
      model,
      traces,
    });
    const failures = new FailureNotificationService({
      db: database.db,
      config,
      egress,
      queue,
      traces,
    });
    const dailyBrief = new DailyBriefService({
      db: database.db,
      config,
      agent,
      runs,
      memory,
      connections,
      egress,
      failures,
      queue,
      traces,
      projector,
    });
    const turn = new InboundTurnService({
      db: database.db,
      config,
      agent,
      runs,
      history: new ConversationHistoryStore(
        database.db,
        config.limits.recentMessageLimit,
      ),
      memory,
      connections,
      recovery,
      egress,
      failures,
      traces,
    });
    const handlers: JobHandlers = {
      inbound: (job, context) => turn.handle(job, context),
      daily_brief: (job, context) => dailyBrief.handle(job, context),
      memory_maintenance: async (job, context) => {
        const runId = memoryMaintenancePayload(job.payload);
        if (job.runId !== runId || job.subjectId !== runId) {
          throw new Error("Memory maintenance job identity is inconsistent");
        }
        context.assertLease();
        await maintenance.maintainRun({
          runId,
          deadlineAtMs: Math.min(
            Date.now() + memoryMaintenanceBudgetMs,
            job.leaseExpiresAtMs - memoryMaintenanceLeaseMarginMs,
          ),
        });
        context.assertLease();
      },
      egress_send: async (job, context) => {
        const payload = egressPayload(job.payload);
        context.assertLease();
        await egress.sendPrepared(
          payload.egressId,
          job,
          payload.sendPolicy === undefined
            ? undefined
            : {
                policy: payload.sendPolicy,
                enabled: config.dailyBrief.enabled,
              },
        );
      },
      egress_reconcile: async (job, context) => {
        context.assertLease();
        const egressId = egressPayload(job.payload).egressId;
        try {
          const result = await egress.reconcile(egressId);
          context.assertLease();
          if (result.kind === "pending") {
            throw new RetryableJobError(
              "Sendblue delivery is still pending",
              Math.max(250, result.retryAtMs - Date.now()),
            );
          }
        } catch (error) {
          if (error instanceof RetryableJobError) {
            if (queue.canRetry(job)) {
              throw error;
            }
            context.assertLease();
            egress.markReconciliationUnknown(egressId, "retry_attempts_exhausted");
            return;
          }
          if (error instanceof MessagingProviderError) {
            if (error.kind !== "terminal" && queue.canRetry(job)) {
              throw new RetryableJobError(
                "Sendblue delivery reconciliation failed transiently",
                error.retryAfterMs ?? 5_000,
                { cause: error },
              );
            }
            context.assertLease();
            egress.markReconciliationUnknown(egressId, `provider_${error.kind}`);
            return;
          }
          throw error;
        }
      },
    };
    const worker = new DurableWorker({
      queue,
      handlers,
      projector,
      pollMs: config.limits.workerPollMs,
      leaseMs: config.limits.jobLeaseMs,
    });
    const ingress = new MessageIngressService({
      db: database.db,
      queue,
      traces,
      projector,
      lineNumber: config.sendblue.fromNumber,
      trustedSender: config.userPhoneNumber,
    });
    const receiver = new SendblueReceiver({
      db: database.db,
      gateway: messages,
      ingress,
      traces,
      projector,
    });
    receiver.initialize();
    const app = fastify({
      logger: overrides.logger === false ? false : { level: config.logLevel },
      bodyLimit: 1_048_576,
    });
    let ready = false;
    app.get("/health", async (_request, reply) => {
      if (!ready) {
        return reply.code(503).send({ ok: false, ready: false });
      }
      return reply.send({ ok: true, ready: true, database: database.health() });
    });
    registerGoogleOAuth({ app, config, links, attempts, connections, traces });
    registerNotionOAuth({ app, config, links, attempts, connections, traces });

    writes.recoverOpenAttempts();
    recovery.planPendingReconnects("google");
    await maintenance.recoverInterrupted();
    projector.projectPending();
    new TraceRetentionService({
      db: database.db,
      traceDir: config.traceDir,
      retentionDays: config.traceRetentionDays,
      maximumBytes: config.traceMaxBytes,
    }).cleanup();

    return {
      app,
      database,
      worker,
      receiver,
      dailyBrief,
      handlers,
      queue,
      traces,
      projector,
      tools,
      localUi: { connections, links, memory },
      isReady() {
        return ready;
      },
      setReady(value) {
        ready = value;
      },
      async close() {
        ready = false;
        receiver.close();
        await app.close();
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

function egressPayload(value: unknown): {
  egressId: ReturnType<typeof asEgressId>;
  sendPolicy?: EgressSendPolicy;
} {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("egressId" in value) ||
    typeof value.egressId !== "string"
  ) {
    throw new Error("Egress job payload is invalid");
  }
  const egressId = asEgressId(value.egressId);
  if (!("sendPolicy" in value) || value.sendPolicy === undefined) {
    return { egressId };
  }
  const sendPolicy = value.sendPolicy;
  if (
    sendPolicy === null ||
    typeof sendPolicy !== "object" ||
    Array.isArray(sendPolicy) ||
    !("kind" in sendPolicy) ||
    sendPolicy.kind !== "daily_brief" ||
    !("expiresAtMs" in sendPolicy) ||
    typeof sendPolicy.expiresAtMs !== "number" ||
    !Number.isSafeInteger(sendPolicy.expiresAtMs) ||
    sendPolicy.expiresAtMs < 0
  ) {
    throw new Error("Egress send policy is invalid");
  }
  return {
    egressId,
    sendPolicy: { kind: "daily_brief", expiresAtMs: sendPolicy.expiresAtMs },
  };
}

function memoryMaintenancePayload(value: unknown): ReturnType<typeof asRunId> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("runId" in value) ||
    typeof value.runId !== "string"
  ) {
    throw new Error("Memory maintenance job payload is invalid");
  }
  return asRunId(value.runId);
}

function assertProductionTools(tools: ToolRegistry): void {
  const expected = [
    "gmail.search",
    "gmail.read_thread",
    "google.search",
    "google.read",
    "notion.search",
    "notion.fetch",
    "notion.create_page",
    "notion.update_page",
  ];
  const actual = tools.definitions().map((tool) => tool.name);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Production tool registry drifted: ${actual.join(", ")}`);
  }
}

function assertAgentTools(agentTools: ToolRegistry, providerTools: ToolRegistry): void {
  const expected = [
    ...providerTools.definitions().map((tool) => tool.name),
    "connections.list",
    "connections.connect",
  ];
  const actual = agentTools.definitions().map((tool) => tool.name);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`Agent tool registry drifted: ${actual.join(", ")}`);
  }
}

