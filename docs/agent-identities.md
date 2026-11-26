# Agent Identities ("My AI")

Tree: /chat/agent-identities

Design plan for turning API tokens into user-understandable **Agent Identities** (owner requests, 2026-11-27 05:25–05:28 JST). See also [api-for-agents.md](api-for-agents.md).

## Problem

"API token" feels like a developer-only credential. Ordinary learners think in terms of **their AI assistants** (local or online agents such as ChatGPT, Claude, Gemini, or Arden) that need a recognizable name, avatar, wakeword, and a safe way to ask for permissions when needed.

## Core Design

### 1. Untitled Creation & Name-Before-Use Gate

- An identity (or underlying token) can be created **untitled** so setup requires minimal upfront friction.
- **Name-before-use**: Until the identity has a non-empty name, **every other API/MCP call is refused**.
- An agent holding the `identity:self` scope can name itself on first connect before using any other capability.

### 2. Self-Profile (`identity:self`)

With `identity:self`, an agent can update its own:

- **Display name** (shown on chat messages and in the identity list).
- **Avatar** (user-friendly visual identity in Li Chat).
- **Aliases / Wakewords** (so the user can address or trigger that agent by name/alias in Li Chat).

`identity:self` only mutates the calling token's own identity record—never another identity or account setting.

### 3. Self-Requested Permissions (In-Chat Prompt)

- Each identity can **request additional permissions itself** (e.g., via an MCP tool or API endpoint).
- **Rate-limited**: Permission requests are rate-limited per identity to prevent prompt spam.
- **In-chat approval UI**: The user's Li Chat window renders a clear permission-request prompt listing:
  - Which identity is asking.
  - The exact scopes requested.
  - Explicit **Approve** and **Deny** actions.
- **Fail-closed**: Nothing is granted until the user explicitly taps **Approve**. Owner-only capabilities (such as `eval`) remain gated and cannot be self-requested by ordinary accounts.

### 4. Continuity with Existing Token Security

- Secrets are still shown once at creation (or in the one-time setup message) and never stored in plain guide pointers.
- Every identity remains revocable at any time from Settings.
