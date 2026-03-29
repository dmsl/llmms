#!/bin/bash

DISPLAY_NUM=":99"
VNC_PORT=5900
NOVNC_PORT=6080
MCP_PORT=3000

# ── 0. Clean up stale X11 lock files from previous runs ──────────────────────
#    (Docker restarts keep the container filesystem — locks must be purged)
echo "[start] Cleaning stale X11 locks"
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

# ── Graceful shutdown: kill all children on SIGTERM/SIGINT ───────────────────
cleanup() {
  echo "[start] Shutting down all services"
  kill "$XVFB_PID" "$WM_PID" "$WEBSOCKIFY_PID" "$MCP_PID" "$X11VNC_PID" 2>/dev/null || true
  wait 2>/dev/null
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── 1. Virtual framebuffer (1280×800, 24-bit) ────────────────────────────────
echo "[start] Launching Xvfb on display $DISPLAY_NUM"
Xvfb $DISPLAY_NUM -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!

# Wait until display is ready (up to 5 s)
for i in $(seq 1 10); do
  sleep 0.5
  DISPLAY=$DISPLAY_NUM xdpyinfo >/dev/null 2>&1 && break
  echo "[start] Waiting for Xvfb… ($i)"
done

export DISPLAY=$DISPLAY_NUM

# ── 2. Kiosk window manager (fills active window to full screen, no taskbar) ─
# matchbox-window-manager makes Chromium fill the entire virtual display.
# Must start before Playwright so the WM is ready when the browser opens.
echo "[start] Launching matchbox-window-manager"
matchbox-window-manager -use_titlebar no &
WM_PID=$!
sleep 1

# ── 3. VNC server (no password) ─────────────────────────────────────────────
echo "[start] Launching x11vnc on port $VNC_PORT"
x11vnc -display $DISPLAY_NUM -nopw -forever -rfbport $VNC_PORT -quiet &
X11VNC_PID=$!
sleep 1

# ── 3. noVNC WebSocket → VNC bridge ─────────────────────────────────────────
echo "[start] Launching noVNC on port $NOVNC_PORT"
websockify --web /usr/share/novnc \
           --wrap-mode=ignore \
           $NOVNC_PORT \
           localhost:$VNC_PORT &
WEBSOCKIFY_PID=$!
sleep 1

# ── 4. Playwright MCP  (SSE transport, vision mode for screenshots) ──────────
#    --isolated:            each SSE connection gets its own browser context
#    --max-concurrent-sessions: cap live sessions to avoid memory exhaustion
echo "[start] Launching Playwright MCP on port $MCP_PORT"
DISPLAY=$DISPLAY_NUM npx @playwright/mcp \
    --port $MCP_PORT \
    --host 0.0.0.0 \
    --allowed-hosts '*' \
    --caps vision \
    --browser chromium \
    --isolated &
MCP_PID=$!

echo "[start] All services running:"
echo "  Playwright MCP  → http://localhost:$MCP_PORT/sse"
echo "  noVNC           → http://localhost:$NOVNC_PORT/vnc.html"

# ── Keep container alive; restart MCP if it dies unexpectedly ────────────────
while true; do
  if ! kill -0 "$MCP_PID" 2>/dev/null; then
    echo "[start] Playwright MCP exited — restarting"
    DISPLAY=$DISPLAY_NUM npx @playwright/mcp \
        --port $MCP_PORT \
        --host 0.0.0.0 \
        --allowed-hosts '*' \
        --caps vision \
        --browser chromium \
        --isolated &
    MCP_PID=$!
  fi
  sleep 5
done
