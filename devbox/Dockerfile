# Lianki friend dev box (devbox/README.md). Linux, non-root, no credentials baked in.
# Build: docker compose -f devbox/compose.yaml build
FROM node:24-bookworm

ARG BUN_VERSION=1.4.2
ARG CLAUDE_CODE_VERSION=2.1.318
ARG CODEX_VERSION=0.166.0
ARG DSH_VERSION=0.2.1-rc.5

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip tini tmux less vim-tiny ripgrep jq procps bubblewrap \
 && rm -rf /var/lib/apt/lists/*

# gh, for the friend's OWN GitHub login (PRs from their fork). No token baked in.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The image's `node` user (uid 1000) is the only user that runs anything.
ENV BUN_INSTALL=/opt/bun NPM_CONFIG_PREFIX=/opt/npm-global
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && mkdir -p /opt/npm-global \
 && npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force
ENV PATH=/opt/bun/bin:/opt/npm-global/bin:$PATH

# No telemetry from the tools; dsh keeps its own opt-out for session-log upload
# (README, "DeepSeek Harness").
ENV NEXT_TELEMETRY_DISABLED=1 \
    WRANGLER_SEND_METRICS=false \
    DSH_TELEMETRY_MODE=DISABLED \
    DISABLE_TELEMETRY=1

COPY --chmod=755 entrypoint.sh /usr/local/bin/devbox-entrypoint
COPY --chmod=755 start.sh /usr/local/bin/devbox-start

USER node
WORKDIR /home/node
# Created here so the named volume inherits node's ownership on first use.
RUN mkdir -p /home/node/lianki /home/node/.devbox

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/devbox-entrypoint"]
CMD ["devbox-start"]
