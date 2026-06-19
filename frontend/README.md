# Filebox Frontend

A minimal read-only remote file browser built with React, TypeScript, and Vite.

## Features

- **Authentication**: Username/password login with bcrypt-validated credentials
- **File Browser**: Virtualized file list with glob/regex filename filter and refresh button
- **File Preview**: Markdown, code (with syntax highlighting and word-wrap toggle), PDF, and images
- **System Monitoring**: Real-time CPU, memory, swap, load average, and top processes display
- **Agent Management**: Add/remove/enable/disable filesystem roots from the UI
- **Health Panel**: Hub and agent status, RTT, inflight requests, resource revision
- **Responsive Design**: Mobile-friendly with hamburger drawer navigation
- **Warm UI Theme**: Neutral-beige color scheme consistent across all components

## Tech Stack

- React 19
- TypeScript
- Vite 8
- `react-window` for virtualized file lists
- `react-syntax-highlighter` for code preview
- `react-markdown` for Markdown rendering
- PDF.js for PDF preview

## Project Structure

```
src/
  api/
    client.ts          # API client with friendly error messages
  state/
    session.ts         # Login/logout state management
    health.ts          # Health polling state
    events.ts          # SSE event stream
    useIsMobile.ts     # Responsive breakpoint hook
  components/
    Login.tsx           # Username/password login form
    BackendList.tsx     # Agent selector sidebar
    FileBrowser.tsx     # File list with filter and refresh
    PreviewPane.tsx     # File preview container
    MarkdownPreview.tsx # Markdown renderer
    CodePreview.tsx     # Code highlighter with word-wrap toggle
    PdfPreview.tsx      # PDF.js viewer
    ImagePreview.tsx    # Image viewer
    HealthPanel.tsx     # Hub/agent health display
    AgentSettings.tsx   # Root management UI
    RootManager.tsx     # Root CRUD operations
    SystemStats.tsx     # CPU/memory/processes monitor
  App.tsx              # Main app layout with sidebar and routing
  main.tsx             # Entry point
  index.css            # Global styles
```

## Development

```bash
npm install
npm run dev
```

The dev server proxies API requests to the Hub at `http://localhost:3000`.

## Building

```bash
npm run build
```

Output goes to `dist/`. The Hub serves these static files in production.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/session/exchange` | POST | Login with username/password |
| `/api/session/logout` | POST | Logout |
| `/api/health` | GET | Public hub health |
| `/api/agents` | GET | List connected agents |
| `/api/agents/:id` | GET | Get agent details |
| `/api/agents/:id/resources` | GET | Get agent resources |
| `/api/agents/:id/sys-stats` | GET | Get system stats |
| `/api/events` | GET | SSE event stream (agent connect/disconnect, resource updates, progress) |
| `/api/agents/:id/roots` | POST | Add root |
| `/api/agents/:id/roots/:name` | PATCH | Update root |
| `/api/agents/:id/roots/:name` | DELETE | Remove root |
| `/api/fs/list` | GET | List directory contents |
| `/api/fs/stat` | GET | Get file stats |
| `/api/file/raw` | GET | Read file content |

## Configuration

The frontend connects to the Hub API. In development, Vite proxies requests to `http://localhost:3000`. In production, the Hub serves the built frontend files directly.

## Mobile Support

The UI adapts to mobile screens (below 768px) with:
- Hamburger menu for sidebar navigation
- Full-screen file browser or preview (not side-by-side)
- Touch-friendly button sizes
- Responsive table layouts
