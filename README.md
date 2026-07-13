# NetworkMonitor

NetworkMonitor is an Elgato Stream Deck plugin that displays network latency
and a rolling latency chart directly on a Stream Deck key.

## Features

- TCP connection latency measurement (recommended)
- Optional ICMP ping measurement
- Configurable host, TCP port, timeout, and update interval
- Color-coded latency chart refreshed every second by default
- In-memory chart rendering without temporary image files
- macOS and Windows support

## Requirements

- Elgato Stream Deck 6.4 or newer
- Node.js 20
- macOS 12 or newer, or Windows 10 or newer

## Development

Install dependencies:

```bash
npm install
```

Build the plugin:

```bash
npm run build
```

Run Rollup in watch mode and restart the plugin after each build:

```bash
npm run watch
```

The generated plugin code is written to:

```text
com.shalan.networkmonitor.sdPlugin/bin/plugin.js
```

## Installation for development

Copy `com.shalan.networkmonitor.sdPlugin` to the Stream Deck plugins directory:

- macOS: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`
- Windows: `%APPDATA%\Elgato\StreamDeck\Plugins\`

Restart Stream Deck after copying the plugin.

### Installation for development (via npx)

You can link (install) the plugin using Stream Deck CLI without installing it globally:

```bash
npx -y @elgato/cli@latest streamdeck link com.shalan.networkmonitor.sdPlugin
```

Restart Stream Deck after linking the plugin.

## Privacy

The plugin performs latency measurements to the host configured by the user.
It does not implement analytics or telemetry. The Property Inspector loads its
UI component library from `sdpi-components.dev`.
