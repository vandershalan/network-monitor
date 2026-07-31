# NetworkMonitor

NetworkMonitor is an Elgato Stream Deck plugin that displays network latency
and a rolling latency chart directly on a Stream Deck key.

## Features

- TCP connection latency measurement (recommended)
- Optional ICMP ping measurement
- Configurable host, TCP port, timeout, measure interval, and chart update interval
- Color-coded latency chart (default: measure every 500 ms, one averaged point every 1 s)
- In-memory chart rendering without temporary image files
- macOS and Windows support

## Settings

Configure each key in the Stream Deck Property Inspector:

| Setting | Default | Description |
|---|---|---|
| **Host** | `8.8.8.8` | Hostname or IP address to probe |
| **Method** | TCP connect | `TCP connect` (recommended) or `Ping` (ICMP; may be blocked by the network) |
| **Port (TCP)** | `443` | Destination port for TCP connect measurements (ignored for Ping) |
| **Timeout** | `1500 ms` | Max wait for a single measurement (`250`–`5000` ms) |
| **Measure every** (M) | `500 ms` | How often the plugin probes the network (`250`–`5000` ms) |
| **Update chart every** (U) | `1000 ms` | How often one chart point is appended and the key is redrawn (`250`–`5000` ms) |

### Measure vs update

M and U are independent:

- **M ≤ U** (e.g. M=`500 ms`, U=`1000 ms`) — probes more often than the chart updates. Samples collected during each U window are averaged into **one** chart point.
- **M > U** (e.g. M=`1000 ms`, U=`250 ms`) — chart updates more often than probes. The last measurement is repeated on consecutive points until the next probe (so several points share the same value).

Key title color follows latency thresholds: green below 100 ms, yellow below 200 ms, red otherwise (or on error).

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

Then restart the plugin (or Stream Deck) to load changes:

```bash
npx -y @elgato/cli@latest streamdeck restart com.shalan.networkmonitor
```

## Privacy

The plugin performs latency measurements to the host configured by the user.
It does not implement analytics or telemetry. The Property Inspector loads its
UI component library from `sdpi-components.dev`.
