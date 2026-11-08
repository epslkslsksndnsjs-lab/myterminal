# MyTerminal Terms of Service

Last updated: 2026-10-17

These terms cover the hosted MyTerminal plugin and Remote MCP endpoints operated for ChatGPT plugin distribution. The MyTerminal software itself is open-source software licensed under the MIT License; these terms apply to the hosted service that connects ChatGPT to a MyTerminal instance you control.

## 1. The service

The MyTerminal plugin relays tool calls from ChatGPT to a MyTerminal instance that you connect. MyTerminal executes those calls on a machine you control, under your own user account. The service does not execute anything on machines you have not connected.

## 2. Your responsibilities

- You are responsible for the machine you connect, the workspace you authorize, and every action taken inside it.
- Do not use the service to break laws, attack systems, or process data you are not authorized to handle.
- Keep your connector key, Actions token, and session tokens secret. Anyone holding a connector key for a single-tenant deployment can reach that deployment's workspace.

## 3. Data and privacy

- MyTerminal is local-first. Tool calls are executed on your machine; the hosted relay only forwards call payloads and results between ChatGPT and your connected instance.
- Persisted audit records on your machine are sanitized: identity, credential, secret, and message-body fields are redacted before they are written to disk.
- See the privacy notice at `docs/PRIVACY.md` for the full data-flow description.

## 4. Availability and changes

- The service is provided "as is", without warranty of any kind.
- We may change, suspend, or discontinue the hosted endpoints; the open-source software keeps working without them.
- Continued use after a change to these terms constitutes acceptance of the revised terms.

## 5. Contact

Support and questions: https://github.com/epslkslsksndnsjs-lab/myterminal/issues
