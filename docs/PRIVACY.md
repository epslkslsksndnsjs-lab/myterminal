# Privacy notice and deployment template

[中文](PRIVACY.zh-CN.md) · [README](../README.md)

Last updated: July 18, 2026

## Scope

MyTerminal is open-source software that runs on a user's computer. The project maintainers do not operate a hosted MyTerminal service and do not receive workspace files, prompts, messages, session history, credentials, or telemetry merely because someone installs the software.

## Data processed locally

Depending on the tools a user invokes, MyTerminal may process:

- files and Git metadata inside the workspace selected in the TUI;
- structured MyTerminal sessions, task packages, checkpoints, collaboration messages, events, and sanitized tool audits;
- runtime configuration and connection credentials;
- command output produced inside the selected workspace.

Configuration is stored in the user's operating-system configuration directory. Session state and append-only history are stored under `.myterminal` in the selected workspace. MyTerminal does not intentionally transmit telemetry to the project maintainers.

## Data sent to third parties

When a user connects ChatGPT through Actions or Apps, requested tool inputs and outputs travel between the user's MyTerminal instance and OpenAI. When the user exposes MyTerminal with a tunnel or reverse proxy, that provider also carries the traffic. Those services have their own terms and privacy practices.

MyTerminal masks connection credentials in the TUI by default, stores session-token hashes rather than raw session tokens, and redacts identity, authorization, claim-code, credential, secret, password, API-key, message-body, content, and sensitive URL-query fields from persisted call arguments and results. The Logs page otherwise keeps the complete sanitized input and output for local review. These controls reduce exposure but do not replace careful workspace selection or review.

## Retention and deletion

MyTerminal retains structured session history locally until the user deletes it from the TUI or removes the workspace data. Only the TUI owner can permanently delete MyTerminal sessions. Source files and Git history remain governed by the user's normal project workflow.

## Public GPT deployments

This document describes the upstream, unhosted software. If you publish a GPT that connects to your own MyTerminal endpoint, you are responsible for a privacy policy that accurately identifies you, the data your GPT processes, the tunnel or hosting providers involved, retention, deletion requests, and contact information. Do not present this upstream notice as covering a hosted deployment unless it is accurate for that deployment.

OpenAI currently requires a valid privacy-policy URL for public GPTs with Actions; see [Configuring actions in GPTs](https://help.openai.com/en/articles/9442513).

## Security and questions

Use a dedicated workspace, keep the Actions token private, stop public tunnels when not needed, and review MyTerminal's Diff and Logs pages. For project questions, open an issue in the [MyTerminal repository](https://github.com/epslkslsksndnsjs-lab/myterminal/issues). Do not include credentials, private source code, or session tokens in an issue.
