import streamDeck, { action, DidReceiveSettingsEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { spawn } from 'child_process';
import { createCanvas } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import net from 'net';

@action({ UUID: "com.shalan.networkmonitor.latency" })
export class NetworkLatencyMonitor extends SingletonAction<LatencySettings> {
    private measureTimeoutId?: NodeJS.Timeout;
    private displayIntervalId?: NodeJS.Timeout;
    private monitoring = false;
    private measuring = false;
    private visibleActions = new Map<string, any>();
    private targetHost: string = DEFAULT_SETTINGS.targetHost;
    private measureIntervalMs: number = DEFAULT_SETTINGS.measureIntervalMs;
    private displayIntervalMs: number = DEFAULT_SETTINGS.displayIntervalMs;
    private timeoutMs: number = DEFAULT_SETTINGS.timeoutMs;
    private method: LatencyMethod = DEFAULT_SETTINGS.method;
    private tcpPort: number = DEFAULT_SETTINGS.tcpPort;
    private latencyHistory: number[] = [];
    /** Samples collected since the last chart point (used when M ≤ U). */
    private sampleBuffer: number[] = [];
    /** Most recent measurement (used when M > U to repeat the same value). */
    private lastSample: number | null = null;
    private maxHistoryLength: number = 60;
    private tempDir: string = path.join(os.tmpdir(), 'networkmonitor');
    private evenOdd = '0';

    private pingProcess: ReturnType<typeof spawn> | null = null;
    private latestLatency: number = -1;
    private pingBuffer: string = '';

    constructor() {
        super();
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    override async onWillAppear(ev: WillAppearEvent): Promise<void> {
        const settings = this.withDefaults(ev.payload.settings);
        await ev.action.setSettings(settings);
        this.applySettings(settings);

        this.visibleActions.set(ev.action.id, ev.action);

        if (!this.monitoring) {
            this.startMonitoring();
        }
    }

    override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
        this.visibleActions.delete(ev.action.id);

        if (this.visibleActions.size === 0) {
            this.stopMonitoring();
        }
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LatencySettings>): Promise<void> {
        const prev = {
            method: this.method,
            host: this.targetHost,
            port: this.tcpPort,
            measureIntervalMs: this.measureIntervalMs,
            displayIntervalMs: this.displayIntervalMs,
            timeoutMs: this.timeoutMs
        };

        const incoming = ev.payload.settings ?? {};
        const settings = this.withDefaults(incoming);

        // Avoid echoing settings on every change — that fights the Property Inspector sliders.
        const hasLegacyKeys =
            incoming.updateIntervalMs != null ||
            incoming.sampleIntervalMs != null ||
            incoming.samplesPerPoint != null;
        const needsMigrationWrite =
            hasLegacyKeys ||
            incoming.measureIntervalMs == null ||
            incoming.displayIntervalMs == null;

        if (needsMigrationWrite) {
            await ev.action.setSettings(settings);
        }

        this.applySettings(settings);

        if (prev.method !== this.method || prev.host !== this.targetHost || prev.port !== this.tcpPort) {
            this.resetHistory();
        }

        const cadenceChanged =
            prev.measureIntervalMs !== this.measureIntervalMs ||
            prev.displayIntervalMs !== this.displayIntervalMs ||
            prev.timeoutMs !== this.timeoutMs ||
            prev.method !== this.method ||
            prev.host !== this.targetHost ||
            prev.port !== this.tcpPort;

        if (cadenceChanged && this.visibleActions.size > 0) {
            this.stopMonitoring();
            this.startMonitoring();
        }
    }

    private withDefaults(settings: LatencySettings | undefined): ResolvedLatencySettings {
        const incoming = settings ?? {};
        const measureIntervalMs = this.resolveMeasureInterval(incoming);
        const displayIntervalMs = this.resolveDisplayInterval(incoming, measureIntervalMs);

        return {
            targetHost: (incoming.targetHost || DEFAULT_SETTINGS.targetHost).trim(),
            method: incoming.method === 'ping' ? 'ping' : 'tcp',
            tcpPort: this.clampPort(incoming.tcpPort ?? DEFAULT_SETTINGS.tcpPort),
            timeoutMs: this.clampTimeout(incoming.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs),
            measureIntervalMs,
            displayIntervalMs
        };
    }

    private resolveMeasureInterval(settings: LatencySettings): number {
        if (settings.measureIntervalMs != null) {
            return this.clampInterval(settings.measureIntervalMs, DEFAULT_SETTINGS.measureIntervalMs);
        }
        // Legacy: sampleIntervalMs, or older updateIntervalMs as the sole cadence
        if (settings.sampleIntervalMs != null) {
            return this.clampInterval(settings.sampleIntervalMs, DEFAULT_SETTINGS.measureIntervalMs);
        }
        if (settings.updateIntervalMs != null) {
            return this.clampInterval(settings.updateIntervalMs, DEFAULT_SETTINGS.measureIntervalMs);
        }
        return DEFAULT_SETTINGS.measureIntervalMs;
    }

    private resolveDisplayInterval(settings: LatencySettings, fallbackMeasureMs: number): number {
        if (settings.displayIntervalMs != null) {
            return this.clampInterval(settings.displayIntervalMs, DEFAULT_SETTINGS.displayIntervalMs);
        }
        // Legacy: sampleIntervalMs * samplesPerPoint
        if (settings.sampleIntervalMs != null && settings.samplesPerPoint != null) {
            const measureMs = this.clampInterval(settings.sampleIntervalMs, fallbackMeasureMs);
            const samples = this.clampSamplesPerPoint(settings.samplesPerPoint);
            return this.clampInterval(measureMs * samples, DEFAULT_SETTINGS.displayIntervalMs);
        }
        // Legacy single cadence: measure and display were the same
        if (settings.updateIntervalMs != null && settings.sampleIntervalMs == null) {
            return this.clampInterval(settings.updateIntervalMs, DEFAULT_SETTINGS.displayIntervalMs);
        }
        return DEFAULT_SETTINGS.displayIntervalMs;
    }

    private applySettings(settings: ResolvedLatencySettings) {
        this.targetHost = settings.targetHost;
        this.measureIntervalMs = settings.measureIntervalMs;
        this.displayIntervalMs = settings.displayIntervalMs;
        this.timeoutMs = settings.timeoutMs;
        this.tcpPort = settings.tcpPort;
        this.method = settings.method;
        this.sampleBuffer = [];
        this.lastSample = null;
    }

    private startMonitoring() {
        if (this.method === 'ping') {
            this.startContinuousPing();
        } else {
            this.stopPing();
        }

        this.monitoring = true;
        this.sampleBuffer = [];
        this.lastSample = null;
        void this.measureTick();
        this.displayIntervalId = setInterval(() => void this.displayTick(), this.displayIntervalMs);
    }

    private stopMonitoring() {
        this.monitoring = false;
        if (this.measureTimeoutId) {
            clearTimeout(this.measureTimeoutId);
            this.measureTimeoutId = undefined;
        }
        if (this.displayIntervalId) {
            clearInterval(this.displayIntervalId);
            this.displayIntervalId = undefined;
        }

        this.measuring = false;
        this.stopPing();
        this.sampleBuffer = [];
        this.lastSample = null;
    }

    /**
     * M / U semantics (independent cadences):
     * - M = how often we probe the network
     * - U = how often we append exactly one chart point and redraw
     * - M ≤ U: average all samples collected during U, plot that one averaged point
     * - M > U: plot the last measurement repeatedly until the next probe
     */
    private async measureTick() {
        if (!this.monitoring) return;
        if (this.measuring) {
            this.measureTimeoutId = setTimeout(() => void this.measureTick(), this.measureIntervalMs);
            return;
        }

        this.measuring = true;
        try {
            const latency = await this.measureLatency();
            this.lastSample = latency;
            this.sampleBuffer.push(latency);
        } catch (error) {
            streamDeck.logger.error(`Failed to measure latency: ${String(error)}`);
            this.lastSample = -1;
            this.sampleBuffer.push(-1);
        } finally {
            this.measuring = false;
        }

        if (!this.monitoring) return;
        this.measureTimeoutId = setTimeout(() => void this.measureTick(), this.measureIntervalMs);
    }

    private async displayTick() {
        if (!this.monitoring) return;

        let point: number;
        if (this.measureIntervalMs <= this.displayIntervalMs) {
            // Faster (or equal) measure: one averaged point per update window.
            if (this.sampleBuffer.length > 0) {
                point = this.averageSamples(this.sampleBuffer);
                this.sampleBuffer = [];
            } else if (this.lastSample != null) {
                point = this.lastSample;
            } else {
                return;
            }
        } else {
            // Slower measure: hold the last probe across multiple chart points.
            if (this.lastSample == null) return;
            point = this.lastSample;
        }

        this.addLatencyToHistory(point);

        for (const a of this.visibleActions.values()) {
            await this.updateChart(a);
        }
    }

    private resetHistory() {
        this.latencyHistory = [];
        this.sampleBuffer = [];
        this.lastSample = null;
        this.latestLatency = -1;
        this.pingBuffer = '';
    }

    private stopPing() {
        if (!this.pingProcess) return;
        this.pingProcess.kill();
        this.pingProcess = null;
    }

    private startContinuousPing() {
        const platform = os.platform();
        const intervalSec = Math.max(0.2, this.measureIntervalMs / 1000);
        const args =
            platform === 'win32'
                ? ['-t', this.targetHost]
                : ['-i', intervalSec.toString(), this.targetHost];

        const proc = spawn('ping', args);
        this.pingProcess = proc;

        proc.stdout.on('data', (data: Buffer) => {
            this.pingBuffer += data.toString();
            this.processPingOutput();
        });

        proc.stderr.on('data', (data: Buffer) => {
            streamDeck.logger.error(`Ping stderr: ${data.toString()}`);
        });

        proc.on('close', (code: number) => {
            streamDeck.logger.info(`Ping process exited with code ${code}`);
            this.pingProcess = null;
        });
    }

    private processPingOutput() {
        const lines = this.pingBuffer.split('\n');
        this.pingBuffer = lines.pop() || '';

        for (const line of lines) {
            // macOS/Linux: "time=12.3 ms"
            // Windows: "time=12ms" or "time<1ms"
            const timeMatch = line.match(/time[=<]\s*(\d+\.?\d*)\s*ms/i);
            if (!timeMatch?.[1]) continue;

            const pingTime = parseFloat(timeMatch[1]);
            if (Number.isFinite(pingTime)) this.latestLatency = pingTime;
        }
    }

    private async measureLatency(): Promise<number> {
        if (this.method === 'ping') {
            return this.latestLatency;
        }

        return this.measureTcpConnectMs({
            host: this.targetHost,
            port: this.tcpPort,
            timeoutMs: this.timeoutMs
        });
    }

    private measureTcpConnectMs(opts: { host: string; port: number; timeoutMs: number }): Promise<number> {
        const { host, port, timeoutMs } = opts;

        return new Promise((resolve) => {
            const startNs = process.hrtime.bigint();
            const socket = new net.Socket();

            let done = false;
            const finish = (value: number) => {
                if (done) return;
                done = true;
                socket.removeAllListeners();
                socket.destroy();
                resolve(value);
            };

            socket.setTimeout(timeoutMs);

            socket.once('connect', () => {
                const endNs = process.hrtime.bigint();
                const ms = Number(endNs - startNs) / 1_000_000;
                finish(ms);
            });

            socket.once('timeout', () => finish(-1));
            socket.once('error', () => finish(-1));

            socket.connect(port, host);
        });
    }

    private averageSamples(samples: number[]): number {
        const valid = samples.filter((v) => v >= 0);
        if (valid.length === 0) return -1;
        return valid.reduce((sum, v) => sum + v, 0) / valid.length;
    }

    private clampPort(port: unknown): number {
        const n = Number(port);
        if (!Number.isFinite(n)) return DEFAULT_SETTINGS.tcpPort;
        return Math.min(65535, Math.max(1, Math.floor(n)));
    }

    private clampTimeout(ms: unknown): number {
        const n = Number(ms);
        if (!Number.isFinite(n)) return DEFAULT_SETTINGS.timeoutMs;
        return Math.min(5000, Math.max(250, Math.round(n)));
    }

    private clampInterval(ms: unknown, fallback: number): number {
        const n = Number(ms);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(5000, Math.max(250, Math.round(n)));
    }

    private clampSamplesPerPoint(n: unknown): number {
        const v = Number(n);
        if (!Number.isFinite(v)) return 1;
        return Math.min(20, Math.max(1, Math.floor(v)));
    }

    private addLatencyToHistory(latency: number) {
        this.latencyHistory.push(latency);
        if (this.latencyHistory.length > this.maxHistoryLength) {
            this.latencyHistory.shift();
        }
    }

    private async updateChart(action: any) {
        const chartDataUrl = await this.generateLatencyChart();
        await action.setImage(chartDataUrl);

        const currentLatency = this.latencyHistory[this.latencyHistory.length - 1];
        const displayText = currentLatency === -1 ? "ERR" : `${Math.round(currentLatency)} ms`;
        await action.setTitle(displayText);
    }

    private async generateLatencyChart(): Promise<string> {
        const width = 144;
        const height = 144;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);

        if (this.latencyHistory.length === 0) {
            const buffer = canvas.toBuffer('image/png');
            return `data:image/png;base64,${buffer.toString('base64')}`;
        }

        const chartWidth = width - 30;
        const chartHeight = height - 30;
        const maxLatency = 300;

        ctx.beginPath();
        let firstPoint = true;

        this.latencyHistory.forEach((latency, index) => {
            if (latency < 0) return;

            const x = 15 + (index / (this.maxHistoryLength - 1)) * chartWidth;
            const y = height - 15 - (latency / maxLatency) * chartHeight;

            if (firstPoint) {
                ctx.moveTo(x, y);
                firstPoint = false;
            } else {
                ctx.lineTo(x, y);
            }
        });

        const recentLatency = this.latencyHistory[this.latencyHistory.length - 1];
        ctx.strokeStyle = this.getColorForLatency(recentLatency);
        ctx.lineWidth = 2;
        ctx.stroke();

        const mediumY = height - 15 - (100 / maxLatency) * chartHeight;
        const badY = height - 15 - (200 / maxLatency) * chartHeight;

        ctx.beginPath();
        ctx.moveTo(15, mediumY);
        ctx.lineTo(width - 15, mediumY);
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(15, badY);
        ctx.lineTo(width - 15, badY);
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 1;
        ctx.stroke();

        const buffer = canvas.toBuffer('image/png');
        return `data:image/png;base64,${buffer.toString('base64')}`;
    }

    private getColorForLatency(latency: number): string {
        if (latency === -1) return '#ff0000';
        if (latency < 100) return '#00ff00';
        if (latency < 200) return '#ffff00';
        return '#ff0000';
    }
}

type LatencySettings = {
    targetHost?: string;
    method?: LatencyMethod;
    tcpPort?: number;
    timeoutMs?: number;
    /** How often to measure latency. */
    measureIntervalMs?: number;
    /** How often to append one chart point / redraw the key. */
    displayIntervalMs?: number;
    /** @deprecated Prefer measureIntervalMs. */
    sampleIntervalMs?: number;
    /** @deprecated Prefer displayIntervalMs. */
    samplesPerPoint?: number;
    /** @deprecated Prefer measureIntervalMs + displayIntervalMs. */
    updateIntervalMs?: number;
};

type ResolvedLatencySettings = {
    targetHost: string;
    method: LatencyMethod;
    tcpPort: number;
    timeoutMs: number;
    measureIntervalMs: number;
    displayIntervalMs: number;
};

const DEFAULT_SETTINGS: ResolvedLatencySettings = {
    targetHost: "8.8.8.8",
    method: "tcp",
    tcpPort: 443,
    timeoutMs: 1500,
    measureIntervalMs: 500,
    displayIntervalMs: 1000
};

type LatencyMethod = 'tcp' | 'ping';
