import express, { type Express, type Request, type Response } from 'express';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildOpenApi } from './openapi.js';
import { createBuiltinTools } from './core-tools.js';
import { ExtensionService } from './extensions.js';
import { MyTerminalMcpTransport } from './mcp.js';
import { clearL3Quota } from './l3/engine.js';
import { resetL3Adapter, setL3ClusterMode } from './l3/registry.js';
import { resetL3Warmup, startL3Warmup } from './l3/warmup.js';
import { ClusterExtensionRouter } from './cluster-router.js';
import { safeEqual } from './security.js';
import { MyTerminalStore } from './store.js';
import { activeWorkspaceRuntimePids, appendWorkspaceLog, workspaceId } from './instances.js';
import { redact } from './redact.js';
import { WorkspaceCatalog } from './workspace-catalog.js';
import { PortClusterRegistry, tokenHash, type ClusterMember } from './cluster.js';
import { CLUSTER_PROTOCOL_VERSION, CURRENT_VERSION } from './version.js';
import { commandPassiveLock, passiveLockStatus, startPassiveLockService } from './session-resources.js';
import { sessionResourceManager } from './session-resource-manager.js';
import type { JsonObject, MyTerminalConfig, MyTerminalSettings, ToolAuditEvent, ToolResponse } from './types.js';
import { applySubagentDefaults, assessRuntimeEnvironment, createDefaultSettings, readMyTerminalSettings, settingsWithEnvironment, type RuntimeEnvironmentStatus } from './config.js';
import { ControlChannelMonitor, isExternalControlUrl, type ControlChannelState } from './control-channel.js';
import { writeRuntimeLifecycle, type RuntimeLifecyclePhase } from './runtime-lifecycle.js';
import { initSubagentRunner } from './subagent/runner.js';
import { runSubagent } from './subagent/executor.js';
import { listAllSubagents } from './subagent/store.js';

export type RuntimeLog = { at: string; level: 'info' | 'error'; message: string; audit?: ToolAuditEvent };
export type RuntimeHealth = { phase: 'active' | 'revalidating' | 'degraded' | 'shutting_down'; environment: RuntimeEnvironmentStatus; message?: string; lastCheckedAt: string };

/**
 * Process-scoped composition root for one workspace.
 *
 * Ownership boundaries:
 * - owns workspace-local HTTP/MCP servers, timers, store, and runtime lease;
 * - participates in, but does not exclusively own, a shared-port cluster;
 * - may command the installation-global passive-lock helper, but may stop it
 *   only after global process liveness reaches zero.
 */
export class MyTerminalRuntime {
  readonly store: MyTerminalStore;
  readonly extensions: ExtensionService;
  readonly app: Express;
  readonly logs: RuntimeLog[] = [];
  private readonly mcp: MyTerminalMcpTransport;
  private clusterMcp?: MyTerminalMcpTransport;
  private clusterRouter?: ClusterExtensionRouter;
  private readonly internalServer: http.Server;
  private publicServer?: http.Server;
  private address?: AddressInfo;
  private internalAddress?: AddressInfo;
  private cluster?: PortClusterRegistry;
  private clusterMember?: ClusterMember;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private electionTimer?: ReturnType<typeof setInterval>;
  private resumeTimer?: ReturnType<typeof setInterval>;
  private controlChannel?: ControlChannelMonitor;
  private lastMonotonicTick = performance.now();
  private revalidating = false;
  private closing?: Promise<void>;
  private runtimeLogRevisionValue = 0;
  private healthState: RuntimeHealth = { phase: 'active', environment: { status: 'valid' }, lastCheckedAt: new Date().toISOString() };
  readonly workspaceCatalog: WorkspaceCatalog;

  constructor(readonly config: MyTerminalConfig) {
    this.workspaceCatalog = WorkspaceCatalog.fromConfig(config);
    sessionResourceManager.reap(config);
    this.store = new MyTerminalStore(config.stateDir);
    const builtins = createBuiltinTools(config, this.store);
    this.extensions = new ExtensionService(config, this.store, builtins, (event) => this.logAuditEvent(event));
    // M8：初始化 SubagentRunner——读 settings 获取 subagent 配置，注入 delegate + callSubagent 通知链路。
    // ADR-0045（spine）：仅当配置显式提供 baseUrl + apiKey（新契约）才启动 subagent；
    // 遗留 provider 配置或零默认（无 subagent 段）均不启动。
    const settings = settingsWithEnvironment(readMyTerminalSettings() ?? createDefaultSettings(config.workspaceDir), process.env);
    // ADR-0045（spine）+ code-review S#5：server 重读 settings 不经 validateSettings，
    // 必须在此显式施加 subagent 可选字段默认值，否则最小配置下 executor 因
    // timeoutSec/maxTurns=undefined 崩溃。
    const subagentSettings = settings.subagent ? applySubagentDefaults(settings.subagent) : undefined;
    // ADR-0045（spine）：仅当配置显式提供 model + baseUrl + apiKey（新契约三必填）才启动 subagent；
    // 遗留 provider 配置或零默认（无 subagent 段）均不启动。
    if (subagentSettings?.model && subagentSettings?.baseUrl && subagentSettings?.apiKey) {
      initSubagentRunner({
      runSubagentImpl: runSubagent,
      settings: subagentSettings,
      workspaceDir: config.workspaceDir,
      notify: async (childId, childIdentity, parentId, body) => {
        await this.extensions.callSubagent(
          { tool: 'message_send', input: { to: parentId, body }, identity: childIdentity },
          { transport: 'subagent' },
        );
      },
      checkpoint: async (childId, childIdentity, phase, summary) => {
        await this.extensions.callSubagent(
          { tool: 'session_checkpoint', input: { phase, summary }, identity: childIdentity },
          { transport: 'subagent' },
        );
      },
      registerAndClaimChild: (parentId, args) => {
        const { session, claimCode } = this.store.registerDelegate(parentId, { name: args.name, task: args.task });
        const result = this.store.inherit(session.id, { claimCode });
        return { session: result.session, identity: result.identity };
      },
    });
    }
    this.mcp = new MyTerminalMcpTransport(this.extensions);
    this.app = express();
    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '2mb' }));
    this.internalServer = http.createServer(this.app);
    this.configureRoutes();
    this.persistRuntimeLifecycle('starting', 'runtime constructed');
  }

  private persistRuntimeLifecycle(phase: RuntimeLifecyclePhase, reason?: string): void {
    try {
      writeRuntimeLifecycle(this.config.stateDir, {
        workspace: this.config.workspaceDir,
        pid: process.pid,
        phase,
        reason,
        pendingActions: this.extensions.activeActionCount(),
        controlChannel: this.controlChannel?.snapshot().phase,
      });
    } catch { /* lifecycle persistence must not mask the original runtime failure */ }
  }

  runtimeHealth(): RuntimeHealth { return { ...this.healthState, environment: { ...this.healthState.environment } }; }
  controlChannelStatus(): ControlChannelState | undefined { return this.controlChannel?.snapshot(); }

  private settingsSnapshot(): MyTerminalSettings {
    return {
      schemaVersion: 1,
      workspaceDir: this.config.workspaceDir,
      host: this.config.host,
      port: this.config.port,
      connectorKey: this.config.connectorKey,
      actionsToken: this.config.actionsToken,
      publicBaseUrl: this.config.publicBaseUrl,
      maxOutputChars: this.config.maxOutputChars,
      commandTimeoutSec: this.config.commandTimeoutSec,
      uiLanguage: this.config.uiLanguage,
      uiTheme: this.config.uiTheme,
      passiveLockEnabled: this.config.passiveLockEnabled,
      actionsContinuationMode: this.config.actionsContinuationMode,
      nonBlockingTasksEnabled: this.config.nonBlockingTasksEnabled,
    };
  }

  async revalidateAfterResume(reason = 'periodic health check'): Promise<RuntimeHealth> {
    if (this.revalidating || this.healthState.phase === 'shutting_down') return this.runtimeHealth();
    this.revalidating = true;
    this.healthState = { ...this.healthState, phase: 'revalidating', message: reason, lastCheckedAt: new Date().toISOString() };
    this.persistRuntimeLifecycle('revalidating', reason);
    // Active actions are live in-memory operations, not stale persisted records.
    // Resume recovery must not mark them failed while their side effects continue.
    if (this.controlChannel && !/control channel/i.test(reason)) void this.controlChannel.recheck();
    try {
      const environment = assessRuntimeEnvironment(this.settingsSnapshot());
      if (environment.status !== 'valid') {
        this.healthState = { phase: 'degraded', environment, message: environment.message, lastCheckedAt: new Date().toISOString() };
        this.persistRuntimeLifecycle('degraded', environment.message);
        this.log(`Runtime degraded: ${environment.message}`, 'error');
        return this.runtimeHealth();
      }
      if (!this.internalServer.listening) throw new Error('Internal server is no longer listening.');
      if (this.cluster) {
        this.cluster.ensureRegistered();
        await this.tryBecomeLeader();
      } else if (!this.publicServer?.listening) {
        throw new Error('Public server is no longer listening.');
      }
      this.publishWorkspaceRuntime();
      try { await this.diffCapabilityProbe(); } catch (error) { this.log(`Git capability revalidation failed: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
      this.healthState = { phase: 'active', environment, lastCheckedAt: new Date().toISOString() };
      this.persistRuntimeLifecycle('active', reason);
      this.log(`Runtime recovery completed: workspace, local servers, cluster registration, and log persistence revalidated after ${reason}.`);
      return this.runtimeHealth();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.healthState = { phase: 'degraded', environment: { status: 'state_dir_unavailable', message }, message, lastCheckedAt: new Date().toISOString() };
      this.persistRuntimeLifecycle('degraded', message);
      this.log(`Runtime revalidation failed: ${message}`, 'error');
      return this.runtimeHealth();
    } finally { this.revalidating = false; }
  }

  private async diffCapabilityProbe(): Promise<void> {
    await import('node:fs/promises').then(({ access }) => access(this.config.workspaceDir));
  }

  private startResumeMonitor(): void {
    const intervalMs = 2000;
    this.lastMonotonicTick = performance.now();
    this.resumeTimer = setInterval(() => {
      const now = performance.now();
      const gap = now - this.lastMonotonicTick;
      this.lastMonotonicTick = now;
      if (gap > intervalMs * 3 || this.healthState.phase === 'degraded') {
        void this.revalidateAfterResume(gap > intervalMs * 3 ? `suspend/resume gap detected (${Math.round(gap)}ms)` : 'degraded runtime retry')
          .catch((error) => this.log(`Resume monitor failed: ${error instanceof Error ? error.message : String(error)}`, 'error'));
      }
    }, intervalMs);
    this.resumeTimer.unref?.();
  }

  get port(): number {
    return this.address?.port ?? this.config.port;
  }

  clusterVersions(): string[] {
    if (!this.cluster) return [CURRENT_VERSION];
    const state = this.cluster.ensureRegistered();
    return [...new Set(state.members.filter((item) => {
      try { process.kill(item.pid, 0); return true; } catch { return false; }
    }).map((item) => item.appVersion))].sort();
  }

  clusterMemberCount(): number {
    const topology = this.processTopology();
    if (topology.mode === 'degraded' || topology.memberCount === undefined) {
      throw new Error(topology.error || 'Cluster topology is unavailable.');
    }
    return topology.memberCount;
  }

  /** Return persisted process topology after enforcing local membership. */
  processTopology(): {
    mode: 'single-workspace' | 'shared-port' | 'degraded';
    sharedPort: number;
    memberCount?: number;
    role: 'standalone' | 'leader' | 'member' | 'unknown';
    pid: number;
    error?: string;
  } {
    if (!this.cluster) {
      return { mode: 'single-workspace', sharedPort: this.port, memberCount: 1, role: 'standalone', pid: process.pid };
    }
    try {
      const state = this.cluster.ensureRegistered();
      const liveMembers = state.members.filter((member) => {
        try { process.kill(member.pid, 0); return true; } catch { return false; }
      });
      const local = liveMembers.find((member) => member.id === this.cluster!.memberId);
      if (!local) throw new Error('Local cluster membership could not be restored.');
      const isLeader = this.publicServer?.listening || state.leaderId === local.id;
      return {
        mode: liveMembers.length === 1 ? 'single-workspace' : 'shared-port',
        sharedPort: state.port,
        memberCount: liveMembers.length,
        role: liveMembers.length === 1 ? 'standalone' : isLeader ? 'leader' : 'member',
        pid: process.pid,
      };
    } catch (error) {
      return {
        mode: 'degraded',
        sharedPort: this.port,
        role: 'unknown',
        pid: process.pid,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  passiveLockStatus(): ReturnType<typeof passiveLockStatus> {
    return passiveLockStatus(this.config);
  }

  get appsUrl(): string {
    return `${this.resolvedPublicBaseUrl()}/mcp/${this.config.connectorKey}`;
  }

  get openApiUrl(): string {
    return `${this.resolvedPublicBaseUrl()}/openapi.json`;
  }

  activeMcpSessions(): number {
    return this.mcp.activeSessions();
  }

  /** M8：TUI Subagents tab 数据源——返回所有 subagent 记录 */
  listSubagents() {
    return listAllSubagents();
  }

  runtimeLogRevision(): number { return this.runtimeLogRevisionValue; }

  private logAuditEvent(event: ToolAuditEvent): void {
    const suffix = event.status === 'running' ? '' : ` · ${event.durationMs}ms`;
    const error = event.error?.code ? ` · ${event.error.code}` : '';
    const entry: RuntimeLog = {
      at: event.timestamp,
      level: event.status === 'failed' || event.status === 'timeout' ? 'error' : 'info',
      message: redact(`Action ${event.status}: ${event.action} · session ${event.session}${suffix}${error}`) as string,
      audit: redact(event) as ToolAuditEvent,
    };
    const index = this.logs.findIndex((item) => item.audit?.id === event.id);
    if (index >= 0) this.logs[index] = entry;
    else this.logs.push(entry);
    try { appendWorkspaceLog(this.config.stateDir, entry); } catch { /* logging must never crash the runtime */ }
    if (this.logs.length > 500) this.logs.shift();
    this.runtimeLogRevisionValue += 1;
  }

  log(message: string, level: RuntimeLog['level'] = 'info'): void {
    const entry = { at: new Date().toISOString(), level, message: redact(message) as string };
    this.logs.push(entry);
    try { appendWorkspaceLog(this.config.stateDir, entry); } catch { /* logging must never crash the runtime */ }
    if (this.logs.length > 500) this.logs.shift();
    this.runtimeLogRevisionValue += 1;
  }

  private startControlChannelMonitor(): void {
    const baseUrl = this.resolvedPublicBaseUrl();
    const ownsPublicEndpoint = this.config.port === 0 || Boolean(this.publicServer?.listening);
    if (!ownsPublicEndpoint || !isExternalControlUrl(baseUrl) || this.controlChannel) return;
    let connectedOnce = false;
    let outageClassification: ControlChannelState['classification'];
    let reconnectingLogged = false;
    this.controlChannel = new ControlChannelMonitor({
      baseUrl,
      expectedWorkspaceId: workspaceId(this.config.workspaceDir),
      onState: (state) => {
        if (!['connected', 'recovering', 'disconnected'].includes(state.phase)) return;
        if (this.healthState.phase !== 'shutting_down') this.persistRuntimeLifecycle(this.healthState.phase, state.message);
        if (state.phase === 'connected') {
          if (outageClassification) this.log('Control channel reconnected; validating local runtime state.');
          else if (!connectedOnce) this.log('Control channel connected.');
          connectedOnce = true;
          outageClassification = undefined;
          reconnectingLogged = false;
          return;
        }
        if (state.phase === 'recovering') {
          if (outageClassification && !reconnectingLogged) {
            reconnectingLogged = true;
            this.log('Control channel reconnecting.');
          }
          return;
        }
        if (!outageClassification || outageClassification !== state.classification) {
          this.log(`Control channel disconnected: ${state.classification || 'unknown'} · retry ${state.attempt} in ${state.retryDelayMs}ms · ${state.message || ''}`, 'error');
        }
        outageClassification = state.classification;
      },
      onRecovered: async () => { await this.revalidateAfterResume('control channel reconnected'); },
    });
    this.controlChannel.start();
  }

  private stopControlChannelMonitor(): void {
    this.controlChannel?.stop();
    this.controlChannel = undefined;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.internalServer.once('error', reject);
      this.internalServer.listen(0, '127.0.0.1', () => {
        this.internalServer.off('error', reject);
        this.internalAddress = this.internalServer.address() as AddressInfo;
        resolve();
      });
    });
    if (this.config.port === 0) {
      await this.becomeStandaloneLeader(0);
      // D18.2：standalone（无 cluster）→ L3 默认开
      setL3ClusterMode(false);
      // ADR-0051 D-6（#91 W2-08）：standalone 异步预热（fire-and-forget，start 不等待；
      // 全失败仅记日志；env 关 / cluster 默认关由 l3Enabled 内部 gate）
      startL3Warmup((message, level) => this.log(message, level));
      this.publishWorkspaceRuntime();
      this.startConfiguredPassiveLock();
      this.startResumeMonitor();
      this.startControlChannelMonitor();
      this.persistRuntimeLifecycle('active', 'standalone runtime started');
      return;
    }
    this.cluster = new PortClusterRegistry(path.dirname(this.config.settingsPath), this.config.host, this.config.port);
    // D18.2：cluster 参与者 → L3 默认关（避免 N×1.1GB RAM 乘散）；env 可覆盖，注册时定一次
    setL3ClusterMode(true);
    this.clusterMember = this.cluster.register({
      pid: process.pid,
      appVersion: CURRENT_VERSION,
      protocolVersion: CLUSTER_PROTOCOL_VERSION,
      workspaceId: workspaceId(this.config.workspaceDir),
      workspaceDir: this.config.workspaceDir,
      internalPort: this.internalAddress!.port,
      connectorKey: this.config.connectorKey,
      actionsTokenHash: tokenHash(this.config.actionsToken),
      secret: randomBytes(24).toString('hex'),
    });
    this.clusterRouter = new ClusterExtensionRouter(this.cluster, this.cluster.memberId);
    this.clusterMcp = new MyTerminalMcpTransport(this.clusterRouter);
    await this.tryBecomeLeader();
    const state = this.cluster.read();
    const leader = state.members.find((item) => item.id === state.leaderId);
    if (!this.publicServer?.listening && !leader) {
      try { this.cluster.unregister(); } catch { /* best effort */ }
      await new Promise<void>((resolve) => this.internalServer.close(() => resolve()));
      const cause = Object.assign(new Error(`listen EADDRINUSE: address already in use ${this.config.host}:${this.config.port}`), { code: 'EADDRINUSE', syscall: 'listen', address: this.config.host, port: this.config.port });
      const wrapped = new Error(`Failed to start MyTerminal on ${this.config.host}:${this.config.port} [EADDRINUSE]: ${cause.message}`, { cause });
      Object.assign(wrapped, { code: 'EADDRINUSE', host: this.config.host, port: this.config.port, syscall: 'listen' });
      throw wrapped;
    }
    this.heartbeatTimer = setInterval(() => {
      try { this.cluster?.heartbeat(); }
      catch (error) { this.log(`Cluster heartbeat failed: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
    }, 1500);
    this.electionTimer = setInterval(() => {
      if (!this.publicServer?.listening) {
        void this.tryBecomeLeader().catch((error) => this.log(`Cluster election failed: ${error instanceof Error ? error.message : String(error)}`, 'error'));
      }
    }, 1800);
    this.log(this.publicServer?.listening
      ? `MyTerminal cluster leader listening on ${this.config.host}:${this.config.port}`
      : `MyTerminal workspace joined shared port ${this.config.host}:${this.config.port} via PID ${leader?.pid}`);
    this.publishWorkspaceRuntime();
    this.startConfiguredPassiveLock();
    this.startResumeMonitor();
    this.startControlChannelMonitor();
    this.persistRuntimeLifecycle('active', 'cluster runtime started');
  }

  private publishWorkspaceRuntime(): void {
    try { this.workspaceCatalog.publish(this.config, this.port); }
    catch { /* registry is best effort */ }
  }

  private releaseWorkspaceRuntime(): void {
    try { this.workspaceCatalog.release(this.config.workspaceDir); }
    catch { /* registry is best effort */ }
  }

  private startConfiguredPassiveLock(): void {
    if (!this.config.passiveLockEnabled || process.platform !== 'darwin') return;
    // ADR-0024: 异步启动被动锁，不阻塞 runtime
    (async () => {
      try {
        if (!passiveLockStatus(this.config).running) await startPassiveLockService(this.config, 'standby');
      } catch (error) { this.log(error instanceof Error ? error.message : String(error), 'error'); }
    })();
  }

  private async becomeStandaloneLeader(port: number): Promise<void> {
    const server = http.createServer(this.app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.config.host, () => { server.off('error', reject); resolve(); });
    });
    this.publicServer = server;
    this.address = server.address() as AddressInfo;
    this.log(`MyTerminal server listening on ${this.config.host}:${this.address.port}`);
  }

  private async tryBecomeLeader(): Promise<void> {
    if (this.publicServer?.listening || !this.cluster || !this.clusterRouter || !this.clusterMcp) return;
    const gateway = this.createClusterGateway();
    const server = http.createServer(gateway);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.config.port, this.config.host, () => { server.off('error', reject); resolve(); });
      });
      this.publicServer = server;
      this.address = server.address() as AddressInfo;
      this.cluster.setLeader();
      this.log(`This workspace became leader for ${this.config.host}:${this.config.port}`);
      this.startControlChannelMonitor();
    } catch (error) {
      server.close();
      const detail = error as NodeJS.ErrnoException;
      if (detail.code !== 'EADDRINUSE') throw error;
    }
  }

  private createClusterGateway(): Express {
    const gateway = express();
    gateway.disable('x-powered-by');
    gateway.use(express.json({ limit: '2mb' }));
    gateway.get('/health', async (req, res) => {
      const state = this.cluster!.read();
      const requestedWorkspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      if (requestedWorkspaceId) {
        const target = state.members.find((item) => item.workspaceId === requestedWorkspaceId);
        if (!target) {
          res.status(503).json({ ok: false, product: 'myterminal', error: `Workspace ${requestedWorkspaceId} is not registered on this port.` });
          return;
        }
        try {
          const response = await fetch(`http://127.0.0.1:${target.internalPort}/health?workspaceId=${encodeURIComponent(requestedWorkspaceId)}`, { signal: AbortSignal.timeout(2_000) });
          if (!response.ok) {
            res.status(503).json({ ok: false, product: 'myterminal', error: `Workspace ${requestedWorkspaceId} internal health returned HTTP ${response.status}.` });
            return;
          }
        } catch (error) {
          res.status(503).json({ ok: false, product: 'myterminal', error: `Workspace ${requestedWorkspaceId} internal health failed: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
      }
      res.json({ ok: true, product: 'myterminal', version: CURRENT_VERSION, protocolVersion: CLUSTER_PROTOCOL_VERSION, clustered: true, leaderPid: process.pid, workspaces: state.members.map((item) => ({ id: item.workspaceId, workspaceDir: item.workspaceDir, pid: item.pid, version: item.appVersion, protocolVersion: item.protocolVersion })) });
    });
    gateway.get('/openapi.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    gateway.get('/openapi-3.1.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    gateway.all('/mcp/:connectorKey', async (req, res) => {
      if (!safeEqual(String(req.params.connectorKey || ''), this.config.connectorKey)) { res.status(404).json({ error: 'Not found.' }); return; }
      try { await this.clusterMcp!.handle(req, res); }
      catch (error) { this.log(error instanceof Error ? error.message : String(error), 'error'); if (!res.headersSent) res.status(500).json({ error: 'MCP transport failure.' }); }
    });
    gateway.post('/actions/extensions/discover', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.clusterRouter!.discover(req.body, { transport: 'actions' })));
    gateway.post('/actions/extensions/register', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.clusterRouter!.register(req.body, { transport: 'actions' })));
    gateway.post('/actions/extensions/call', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.clusterRouter!.call(req.body, { transport: 'actions' })));
    gateway.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
    return gateway;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.healthState = { ...this.healthState, phase: 'shutting_down', lastCheckedAt: new Date().toISOString() };
    this.persistRuntimeLifecycle('shutting_down', 'runtime close requested');
    sessionResourceManager.disarmAll(this.config);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.electionTimer) clearInterval(this.electionTimer);
    if (this.resumeTimer) clearInterval(this.resumeTimer);
    this.stopControlChannelMonitor();

    // Stop accepting public traffic before removing this member from the shared
    // registry. Doing this in the opposite order leaves a live gateway with an
    // empty member list during shutdown, which surfaces as a false
    // WORKSPACE_UNAVAILABLE response even though another member can take over.
    const publicClosed = this.publicServer?.listening
      ? new Promise<void>((resolve) => this.publicServer!.close(() => resolve()))
      : Promise.resolve();
    try { this.cluster?.unregister(); } catch { /* best effort */ }

    // Abort owned command trees before waiting for HTTP transports to drain.
    // Otherwise a detached command can keep a close request open and continue
    // mutating the workspace after the runtime lease has been released.
    await this.extensions.shutdown();
    // ADR-0050 E2/E3（#81 W1-08）：运行时关闭 → 全量清 L3 配额 + 释放 L3 适配器单例
    // （D6 护栏3「会话结束从 Map 删除」全量面；D8.2「进程退出/会话结束释放」）
    clearL3Quota();
    resetL3Adapter();
    // ADR-0051 D-6（#91 W2-08）：释放预热门闩——「下次启动自动预热」（D-8.1）
    resetL3Warmup();
    await publicClosed;
    await this.mcp.close();
    if (this.clusterMcp) await this.clusterMcp.close();
    if (this.internalServer.listening) await new Promise<void>((resolve) => this.internalServer.close(() => resolve()));
    this.releaseWorkspaceRuntime();

    // The passive-lock helper is global to the MyTerminal installation, not
    // owned by an individual workspace runtime. Stop it only after this lease
    // is released and no other live MyTerminal process remains.
    if (process.platform === 'darwin' && activeWorkspaceRuntimePids(path.dirname(this.config.settingsPath), process.pid).length === 0) {
      try { await commandPassiveLock(this.config, 'stop'); }
      catch (error) { this.log(error instanceof Error ? error.message : String(error), 'error'); }
    }
    this.persistRuntimeLifecycle('stopped', 'runtime closed');
  }

  private configureRoutes(): void {
    this.app.get('/health', (req, res) => {
      const requestedWorkspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      const localWorkspaceId = workspaceId(this.config.workspaceDir);
      const healthy = this.healthState.phase === 'active' || this.healthState.phase === 'revalidating';
      if (requestedWorkspaceId && requestedWorkspaceId !== localWorkspaceId) {
        res.status(503).json({ ok: false, product: 'myterminal', workspaceId: localWorkspaceId, error: 'Workspace route mismatch.' });
        return;
      }
      res.status(healthy ? 200 : 503).json({ ok: healthy, product: 'myterminal', version: CURRENT_VERSION, workspaceId: localWorkspaceId, toolsExposed: 3, sessions: this.store.listSessions().length, activeMcpSessions: this.activeMcpSessions(), pendingActions: this.extensions.activeActionCount(), runtime: this.runtimeHealth(), controlChannel: this.controlChannelStatus() });
    });
    this.app.get('/openapi.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    this.app.get('/openapi-3.1.json', (_req, res) => res.json(buildOpenApi({ ...this.config, publicBaseUrl: this.resolvedPublicBaseUrl() })));
    this.app.all('/mcp/:connectorKey', async (req, res) => {
      if (!safeEqual(String(req.params.connectorKey || ''), this.config.connectorKey)) {
        res.status(404).json({ error: 'Not found.' });
        return;
      }
      try {
        await this.mcp.handle(req, res);
      } catch (error) {
        this.log(error instanceof Error ? error.message : String(error), 'error');
        if (!res.headersSent) res.status(500).json({ error: 'MCP transport failure.' });
      }
    });
    this.app.post('/actions/extensions/discover', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.discover(req.body, { transport: 'actions' })));
    this.app.post('/actions/extensions/register', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.register(req.body, { transport: 'actions' })));
    this.app.post('/actions/extensions/call', this.requireActionsAuth, async (req, res) => this.sendAction(res, await this.extensions.call(req.body, { transport: 'actions' })));
    this.app.post('/cluster/owns', async (req, res) => {
      if (!this.clusterMember || !safeEqual(String(req.header('x-myterminal-cluster-secret') || ''), this.clusterMember.secret)) { res.status(404).json({ error: 'Not found.' }); return; }
      const clientSessionKey = typeof req.body?.clientSessionKey === 'string' ? req.body.clientSessionKey : '';
      res.json({ owned: Boolean(clientSessionKey && this.store.hasAppBinding(clientSessionKey)) });
    });
    this.app.post('/cluster/rpc/:method', async (req, res) => {
      if (!this.clusterMember || !safeEqual(String(req.header('x-myterminal-cluster-secret') || ''), this.clusterMember.secret)) { res.status(404).json({ error: 'Not found.' }); return; }
      const body = req.body as { input?: Record<string, unknown>; context?: Record<string, unknown> };
      const input = body.input || {};
      const context = (body.context || { transport: 'actions' }) as never;
      const method = String(req.params.method || '');
      if (method === 'discover') { res.json(await this.extensions.discover(input, context)); return; }
      if (method === 'register') { res.json(await this.extensions.register(input, context)); return; }
      if (method === 'call') { res.json(await this.extensions.call(input, context)); return; }
      if (method === 'mcpSessionClosed') { this.extensions.mcpSessionClosed(String((input as JsonObject).mcpSessionId || '')); res.json({ ok: true }); return; }
      res.status(404).json({ error: 'Not found.' });
    });
    this.app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
    this.app.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
      this.log(error instanceof Error ? error.message : String(error), 'error');
      res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Malformed request.', retryable: false } });
    });
  }

  private readonly requireActionsAuth = (req: Request, res: Response, next: () => void): void => {
    const header = req.header('authorization') || '';
    const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!candidate || !safeEqual(candidate, this.config.actionsToken)) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Bearer credential required.', retryable: false } });
      return;
    }
    next();
  };

  private sendAction(res: Response, response: ToolResponse): void {
    const status = response.ok ? 200 : response.error?.code === 'NOT_FOUND' ? 404 : response.error?.code === 'INVALID_IDENTITY' || response.error?.code === 'IDENTITY_REQUIRED' ? 401 : 400;
    res.status(status).json(response);
  }

  private resolvedPublicBaseUrl(): string {
    if (this.config.port !== 0) return this.config.publicBaseUrl;
    return this.config.publicBaseUrl.replace(/:\d+$/, `:${this.port}`);
  }
}
