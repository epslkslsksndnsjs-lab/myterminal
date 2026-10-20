// Native event/message shapes for the TUI event pipeline.
//
// Decision (locked, handoff #2): the agent loop runs on myterminal's own
// Anthropic-channel adapter (src/subagent/llm-adapter.ts), NOT min-agent's
// OpenAI-format llm.ts. The render stack only needs the *event shapes*, so
// they are defined here locally instead of importing across trees. M2 wires
// src/agent/loop.ts events to be structurally compatible with AgentEvent.

export type AgentEvent =
  | { type: 'assistant_text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'usage'; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: 'user_interject'; text: string }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' }
  | { type: 'retry'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }

/**
 * Content block: a structured unit of message content.
 * tool_result blocks are embedded in a user message's content blocks.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** Message: user / assistant share the same structure */
export type Message = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}
