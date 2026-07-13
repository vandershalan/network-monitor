import streamDeck, { action, DidReceiveSettingsEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";
import { spawn } from 'child_process';
import { createCanvas } from 'canvas';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import net from 'net';

@action({ UUID: "com.shalan.networkmonitor.latency" })
export class NetworkLatencyMonitor extends SingletonAction<LatencySettings> {
    private intervalId?: NodeJS.Timeout;
    private visibleActions = new Map<string, any>();
    private targetHost: string = DEFAULT_SETTINGS.targetHost;
    private updateIntervalMs: number = DEFAULT_SETTINGS.updateIntervalMs;
    private timeoutMs: number = DEFAULT_SETTINGS.timeoutMs;
    private method: LatencyMethod = DEFAULT_SETTINGS.method;
    private tcpPort: number = DEFAULT_SETTINGS.tcpPort;
    private latencyHistory: number[] = [];
    private maxHistoryLength: number = 60; // Store x data points
    private tempDir: string = path.join(os.tmpdir(), 'networkmonitor');
    private evenOdd = '0';
    
    // New properties for continuous ping
    private pingProcess: ReturnType<typeof spawn> | null = null;
    private latestLatency: number = -1;
    private pingBuffer: string = '';
    
    constructor() {
        super();
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    override async onWillAppear(ev: WillAppearEvent): Promise<void> {
        const settings = this.withDefaults(ev.payload.settings);
        await ev.action.setSettings(settings);
        this.applySettings(settings);

        this.visibleActions.set(ev.action.id, ev.action);

        // Start monitoring when first button appears
        if (!this.intervalId) {
            this.startMonitoring();
        }
    }

    override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
        this.visibleActions.delete(ev.action.id);

        // Stop monitoring when last button is removed
        if (this.visibleActions.size === 0) {
            this.stopMonitoring();
        }
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LatencySettings>): Promise<void> {
        const prev = {
            method: this.method,
            host: this.targetHost,
            port: this.tcpPort
        };

        const settings = this.withDefaults(ev.payload.settings);
        this.applySettings(settings);

        if (prev.method !== this.method || prev.host !== this.targetHost || prev.port !== this.tcpPort) {
            this.resetHistory();
        }

        // Restart monitoring with the new settings (interval/host affects cadence)
        if (this.visibleActions.size > 0) {
            this.stopMonitoring();
            this.startMonitoring();
        }
    }

    private withDefaults(settings: LatencySettings | undefined): LatencySettings {
        return {
            ...DEFAULT_SETTINGS,
            ...(settings ?? {})
        };
    }

    private applySettings(settings: LatencySettings) {
        this.targetHost = (settings.targetHost || DEFAULT_SETTINGS.targetHost).trim();
        this.updateIntervalMs = Math.max(250, Number(settings.updateIntervalMs ?? DEFAULT_SETTINGS.updateIntervalMs));
        this.timeoutMs = Math.max(250, Number(settings.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs));
        this.tcpPort = this.clampPort(settings.tcpPort ?? DEFAULT_SETTINGS.tcpPort);
        this.method = settings.method === 'ping' ? 'ping' : 'tcp';
    }

    private async startMonitoring() {
        // Start the measurement engine for the configured method
        if (this.method === 'ping') {
            this.startContinuousPing();
        } else {
            this.stopPing();
        }
        
        // Set up interval to read latency and update UI
        this.intervalId = setInterval(async () => {
            try {
                // Obtain latency for this tick (method-specific)
                const latency = await this.measureLatency();
                
                // Store the new latency data
                this.addLatencyToHistory(latency);
                
                // Update all visible instances of this action
                for (const a of this.visibleActions.values()) {
                    await this.updateChart(a);
                }
            } catch (error) {
                streamDeck.logger.error(`Failed to process latency: ${String(error)}`);
                this.addLatencyToHistory(-1); // Error state
                for (const a of this.visibleActions.values()) {
                    await this.updateChart(a);
                }
            }
        }, this.updateIntervalMs);
    }

    private stopMonitoring() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        
        this.stopPing();
    }

    private resetHistory() {
        this.latencyHistory = [];
        this.latestLatency = -1;
        this.pingBuffer = '';
    }

    private stopPing() {
        if (!this.pingProcess) return;
        this.pingProcess.kill();
        this.pingProcess = null;
    }

    private startContinuousPing() {
        // Start a continuous ping process (platform differences)
        const platform = os.platform();
        const args =
            platform === 'win32'
                ? ['-t', this.targetHost]
                : ['-i', (this.updateIntervalMs / 1000).toString(), this.targetHost];

        const proc = spawn('ping', args);
        this.pingProcess = proc;
        
        // Handle data from the ping process
        proc.stdout.on('data', (data: Buffer) => {
            const output = data.toString();
            this.pingBuffer += output;
            
            // Process the buffer to extract latency values
            this.processPingOutput();
        });
        
        // Handle errors
        proc.stderr.on('data', (data: Buffer) => {
            streamDeck.logger.error(`Ping stderr: ${data.toString()}`);
        });
        
        // Handle process exit
        proc.on('close', (code: number) => {
            streamDeck.logger.info(`Ping process exited with code ${code}`);
            this.pingProcess = null;
        });
    }
    
    private processPingOutput() {
        // Split the buffer by newlines and process each line
        const lines = this.pingBuffer.split('\n');
        
        // Keep the last line in the buffer if it's incomplete
        this.pingBuffer = lines.pop() || '';
        
        // Process each complete line
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

    private clampPort(port: unknown): number {
        const n = Number(port);
        if (!Number.isFinite(n)) return DEFAULT_SETTINGS.tcpPort;
        return Math.min(65535, Math.max(1, Math.floor(n)));
    }

    private addLatencyToHistory(latency: number) {
        this.latencyHistory.push(latency);
        
        // Maintain history size
        if (this.latencyHistory.length > this.maxHistoryLength) {
            this.latencyHistory.shift();
        }
    }

    private async updateChart(action: any) {
        // Generate chart
        const chartDataUrl = await this.generateLatencyChart();
        
        // Update the button with the chart image
        await action.setImage(chartDataUrl);
        
        // Also set the current latency value as text
        const currentLatency = this.latencyHistory[this.latencyHistory.length - 1];
        const displayText = currentLatency === -1 ? "ERR" : `${Math.round(currentLatency)} ms`;
        await action.setTitle(displayText);
    }

    private async generateLatencyChart(): Promise<string> {
        // Create canvas for the chart
        const width = 144;
        const height = 144;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        
        // Fill background
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
        
        // If we have no data, return empty chart
        if (this.latencyHistory.length === 0) {
            const buffer = canvas.toBuffer('image/png');
            return `data:image/png;base64,${buffer.toString('base64')}`;
        }
        
        // Calculate chart parameters
        const chartWidth = width - 30;
        const chartHeight = height - 30;
        const maxLatency = 300;
        
        // Draw latency line chart
        ctx.beginPath();
        let firstPoint = true;
        
        this.latencyHistory.forEach((latency, index) => {
            // Skip error values
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
        
        // Set line style based on most recent latency
        const recentLatency = this.latencyHistory[this.latencyHistory.length - 1];
        ctx.strokeStyle = this.getColorForLatency(recentLatency);
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Add thresholds
        const mediumY = height - 15 - (100 / maxLatency) * chartHeight;
        const badY = height - 15 - (200 / maxLatency) * chartHeight;
    
        ctx.beginPath();
        ctx.moveTo(15, mediumY);
        ctx.lineTo(width - 15, mediumY);
        ctx.strokeStyle = '#ffff00'; // Semi-transparent yellow
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(15, badY);
        ctx.lineTo(width - 15, badY);
        ctx.strokeStyle = '#ff0000'; // Semi-transparent red
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // Encode chart as base64 PNG (no disk IO)
        const buffer = canvas.toBuffer('image/png');
        return `data:image/png;base64,${buffer.toString('base64')}`;
    }


    private getColorForLatency(latency: number): string {
        if (latency === -1) return '#ff0000'; // Red for error
        if (latency < 100) return '#00ff00';   // Green for good
        if (latency < 200) return '#ffff00';  // Yellow for moderate
        return '#ff0000';                     // Red for high latency
    }
} 

type LatencySettings = {
    targetHost?: string;
    method?: LatencyMethod;
    tcpPort?: number;
    timeoutMs?: number;
    updateIntervalMs?: number;
};

const DEFAULT_SETTINGS: Required<LatencySettings> = {
    targetHost: "8.8.8.8",
    method: "tcp",
    tcpPort: 443,
    timeoutMs: 1500,
    updateIntervalMs: 1000
};

type LatencyMethod = 'tcp' | 'ping';