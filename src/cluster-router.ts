import type { InvocationContext, JsonObject, ToolResponse } from './types.js';
import type { ExtensionFacade } from './mcp.js';
import type { ClusterMember, PortClusterRegistry } from './cluster.js';

function identitySessionId(input: JsonObject): string | undefined {
  const identity = input.identity;
  return identity && typeof identity === 'object' && typeof (identity as JsonObject).sessionId === 'string'
    ? String((identity as JsonObject).sessionId)
    : undefined;
}

function callInput(input: JsonObject): JsonObject {
  const value = input.input ?? input.arguments;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

export class ClusterExtensionRouter implements ExtensionFacade {
  constructor(private readonly registry: PortClusterRegistry, private readonly localMemberId: string) {}

  async discover(input: JsonObject = {}, context: InvocationContext = { transport: 'test' }): Promise<ToolResponse> {
    const sessionId = identitySessionId(input);
    if (sessionId) return await this.routeBySession('discover', input, context, sessionId);
    const bound = await this.boundMember(context);
    if (bound) return await this.invoke(bound, 'discover', input, context);
    const members = this.members();
    const local = members.find((item) => item.id === this.localMemberId) || members[0];
    if (!local) return this.noMembers();
    const response = await this.invoke(local, 'discover', input, context);
    if (response.ok && response.data) {
      response.data.workspaces = members.map((item) => ({ id: item.workspaceId, path: item.workspaceDir, pid: item.pid }));
      response.data.workspaceSelection = 'For session_register(mode=root), pass input.workspaceId using one of the listed workspace IDs.';
    }
    return response;
  }

  async register(input: JsonObject, context: InvocationContext = { transport: 'test' }): Promise<ToolResponse> {
    const sessionId = identitySessionId(input);
    if (!sessionId) {
      const bound = await this.boundMember(context);
      if (bound) return await this.invoke(bound, 'register', input, context);
      return { ok: false, error: { code: 'IDENTITY_REQUIRED', message: 'Extension registration requires session identity.', retryable: false } };
    }
    return await this.routeBySession('register', input, context, sessionId);
  }

  /** ADR-0029: a cluster MCP session closed — broadcast the unbind to every member; unbindMcp is idempotent so only the owning member removes a binding. */
  mcpSessionClosed(mcpSessionId: string): void {
    for (const member of this.members()) {
      fetch(`http://127.0.0.1:${member.internalPort}/cluster/rpc/mcpSessionClosed`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-myterminal-cluster-secret': member.secret },
        body: JSON.stringify({ input: { mcpSessionId }, context: {} }), signal: AbortSignal.timeout(1500),
      }).catch(() => undefined);
    }
  }

  async call(input: JsonObject, context: InvocationContext): Promise<ToolResponse> {
    const tool = typeof input.tool === 'string' ? input.tool : '';
    const args = callInput(input);
    const sessionId = identitySessionId(input) || (tool === 'session_inherit' && typeof args.sessionId === 'string' ? args.sessionId : undefined);
    if (sessionId) return await this.routeBySession('call', input, context, sessionId);
    const bound = await this.boundMember(context);
    if (bound) return await this.invoke(bound, 'call', input, context);
    if (tool === 'session_register' && args.mode !== 'delegate') {
      const members = this.members();
      const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId : undefined;
      const target = workspaceId ? members.find((item) => item.workspaceId === workspaceId) : members.length === 1 ? members[0] : undefined;
      if (!target) return { ok: false, error: { code: 'WORKSPACE_REQUIRED', message: 'Choose input.workspaceId before registering a root session.', retryable: false, details: { workspaces: members.map((item) => ({ id: item.workspaceId, path: item.workspaceDir, pid: item.pid })) } } };
      const forwarded = structuredClone(input);
      const forwardedArgs = callInput(forwarded);
      delete forwardedArgs.workspaceId;
      if (forwarded.input && typeof forwarded.input === 'object') forwarded.input = forwardedArgs;
      else forwarded.arguments = forwardedArgs;
      return await this.invoke(target, 'call', forwarded, context);
    }
    const local = this.members().find((item) => item.id === this.localMemberId) || this.members()[0];
    return local ? await this.invoke(local, 'call', input, context) : this.noMembers();
  }

  private async routeBySession(method: 'discover' | 'register' | 'call', input: JsonObject, context: InvocationContext, _sessionId: string): Promise<ToolResponse> {
    let last: ToolResponse | undefined;
    for (const member of this.members()) {
      const response = await this.invoke(member, method, input, context);
      if (response.ok || !['INVALID_IDENTITY', 'NOT_FOUND'].includes(response.error?.code || '')) return response;
      last = response;
    }
    return last || { ok: false, error: { code: 'NOT_FOUND', message: 'No workspace owns this session.', retryable: false } };
  }


  private async boundMember(context: InvocationContext): Promise<ClusterMember | undefined> {
    if (!context.clientSessionKey) return undefined;
    for (const member of this.members()) {
      try {
        const response = await fetch(`http://127.0.0.1:${member.internalPort}/cluster/owns`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-myterminal-cluster-secret': member.secret },
          body: JSON.stringify({ clientSessionKey: context.clientSessionKey }), signal: AbortSignal.timeout(1500),
        });
        const result = await response.json() as { owned?: boolean };
        if (result.owned) return member;
      } catch { /* try next member */ }
    }
    return undefined;
  }

  private members(): ClusterMember[] { return this.registry.read().members; }

  private async invoke(member: ClusterMember, method: 'discover' | 'register' | 'call', input: JsonObject, context: InvocationContext): Promise<ToolResponse> {
    try {
      const response = await fetch(`http://127.0.0.1:${member.internalPort}/cluster/rpc/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-myterminal-cluster-secret': member.secret },
        body: JSON.stringify({ input, context }), signal: AbortSignal.timeout(5000),
      });
      return await response.json() as ToolResponse;
    } catch (error) {
      return { ok: false, error: { code: 'WORKSPACE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: true } };
    }
  }

  private noMembers(): ToolResponse { return { ok: false, error: { code: 'WORKSPACE_UNAVAILABLE', message: 'No MyTerminal workspace is registered on this port.', retryable: true } }; }
}
