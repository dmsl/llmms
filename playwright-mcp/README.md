# Playwright MCP + Live Browser View

Runs a Playwright-controlled Chromium browser inside Docker.  
The AI agent controls it via MCP tools; visitors watch it live via noVNC in the browser.

## Architecture

```
Browser client
  │
  ├─ WebSocket/SSE ──► Apache /mcp/playwright ──► localhost:3001 ──► Playwright MCP (SSE)
  │                                                                      │
  │                                                              Controls Chromium on :99
  │                                                                      │
  └─ iframe/panel ──► Apache /browser-view/ ──► localhost:6080 ──► noVNC (websockify → x11vnc → Xvfb :99)
```

## Quick Start

```bash
cd playwright-mcp
docker compose up -d --build
```

First build takes ~5 min (downloads Playwright + Chromium).

## Verify

```bash
# Container logs
docker logs playwright-mcp -f

# MCP endpoint
curl http://localhost:3001/sse

# noVNC (open in browser)
http://localhost:6080/vnc.html
```

## Apache Setup

Append `apache-proxy.conf` contents into your SSL VirtualHost, then:

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
sudo systemctl reload apache2
```

Public URLs after Apache setup:
- MCP:  `https://chatucy.cs.ucy.ac.cy/mcp/playwright`
- View: `https://chatucy.cs.ucy.ac.cy/browser-view/vnc.html`

## Chat UI — Connect to MCP

In the chat app's **Servers** panel, add:

| Field | Value |
|---|---|
| Name | `playwright` |
| URL | `wss://chatucy.cs.ucy.ac.cy/mcp/playwright` |
| Auto-connect | ✓ |

## Chat UI — Live View Panel

Add an iframe in `chat.html` pointing to  
`https://chatucy.cs.ucy.ac.cy/browser-view/vnc.html?autoconnect=1&resize=scale&view_only=1`  
(read-only so visitors cannot interact).

## MCP Tools available

Playwright MCP with `--vision` exposes:
- `browser_navigate` — go to URL
- `browser_click` — click element (by screenshot coordinate)
- `browser_type` — type text
- `browser_take_screenshot` — returns current screen as base64 image
- `browser_snapshot` — accessibility tree of current page
- `browser_wait_for` — wait for selector/text

## Demo prompts to try

- *"Go to news.ycombinator.com and summarise the top 3 stories"*
- *"Search for 'MCP protocol' on Google and open the first result"*
- *"Go to the chatucy website and describe what you see"*

## Resource usage

| Resource | Approx |
|---|---|
| RAM | 600–900 MB |
| CPU idle | ~2% |
| CPU during navigation | ~15–30% |
| Disk (image) | ~2.5 GB |
