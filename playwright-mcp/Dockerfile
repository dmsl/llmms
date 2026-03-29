# ── Playwright MCP + noVNC live-view container ──────────────────────────────
# Provides:
#   Port 3000  – Playwright MCP  (SSE / HTTP transport for AI agent)
#   Port 6080  – noVNC web UI    (live browser stream for visitors)
# ─────────────────────────────────────────────────────────────────────────────

FROM mcr.microsoft.com/playwright:v1.50.0-noble

# ── System deps: Xvfb + VNC + noVNC + minimal kiosk WM ─────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        novnc \
        websockify \
        matchbox-window-manager \
        procps \
    && rm -rf /var/lib/apt/lists/*

# ── Node deps: Playwright MCP server ─────────────────────────────────────────
WORKDIR /app
RUN npm install -g @playwright/mcp@latest

# ── Startup script ────────────────────────────────────────────────────────────
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 3000 6080

CMD ["/app/start.sh"]
