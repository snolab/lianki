# Agent Identities ("My AI")

Tree: /chat/agent-identities

Design plan for turning API tokens into user-understandable **Agent Identities** (owner requests, 2026-11-27 05:25–05:28 JST). See also [api-for-agents.md](api-for-agents.md).

## Problem

"API token" feels like a developer-only credential. Ordinary learners think in terms of **their AI assistants** (local or online agents such as ChatGPT, Claude, Gemini, or Arden) that need a recognizable name, avatar, wakeword, and a safe way to ask for permissions when needed.

## Core Design

### 1. One-Tap Entry ("Add My Agent")

- The primary entry point is a single **"Add My Agent"** button.
- Clicking it creates an **untitled** identity with minimal initial capability (`identity:self`) and displays:
  1. **A URL carrying the token** (for quick connection).
  2. **A ready-to-paste prompt** (reusing `/api/agent-guide` and [api-for-agents.md](api-for-agents.md)) telling the agent how to join Lianki: connect over MCP or the CLI, **name yourself first**, then request the permissions you need.
- The learner copies both into ChatGPT, Claude, or their local agent.

### 2. Name-Before-Use Gate

- Until the identity has a non-empty name, **every other API/MCP call is refused** (including permission requests).
- Requiring the name first guarantees that when the agent later requests permissions, the Li Chat approval prompt always shows the agent's real name rather than `"untitled"`.
- An agent holding the `identity:self` scope names itself on first connect before using any other capability.

### 3. Self-Profile (`identity:self`)

With `identity:self`, an agent can update its own:

- **Display name** (shown on chat messages, permission prompts, and the identity list).
- **Avatar** (user-friendly visual identity in Li Chat).
- **Aliases / Wakewords** (so the user can address or trigger that agent by name/alias in Li Chat).

`identity:self` only mutates the calling token's own identity record—never another identity or account setting.

### 4. Self-Requested Permissions (In-Chat Prompt)

- Each identity can **request additional permissions itself** (e.g., via an MCP tool or API endpoint).
- **Rate-limited**: Permission requests are rate-limited per identity to prevent prompt spam.
- **In-chat approval UI**: The user's Li Chat window renders a clear permission-request prompt listing:
  - Which identity is asking.
  - The exact scopes requested.
  - Explicit **Approve** and **Deny** actions.
- **Fail-closed**: Nothing is granted until the user explicitly taps **Approve**. Owner-only capabilities (such as `eval`) remain gated and cannot be self-requested by ordinary accounts.

### 5. Continuity with Existing Token Security

- Secrets are still shown once at creation (or in the one-time setup message) and never stored in plain guide pointers.
- Every identity remains revocable at any time from Settings.
