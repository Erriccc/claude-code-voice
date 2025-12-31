/**
 * VoiceBridgeServer - WebSocket-based persistent browser voice mode
 *
 * Enables continuous voice interaction through a browser tab that stays open.
 * Used for Codespaces, VS Code Web, and other environments where native audio isn't available.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { VoiceService } from './voice-service';

const BRIDGE_PORT = 9877;
const SESSION_CODE_LENGTH = 6;
const SESSION_CODE_EXPIRY = 5 * 60 * 1000; // 5 minutes before connection
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes of inactivity

interface Session {
    code: string;
    token: string;
    createdAt: number;
    lastActivity: number;
    connected: boolean;
    response?: http.ServerResponse;
}

interface WebSocketMessage {
    type: string;
    [key: string]: any;
}

export class VoiceBridgeServer {
    private httpServer: http.Server | undefined;
    private voiceService: VoiceService;
    private sessions: Map<string, Session> = new Map();
    private onTranscript: (transcript: string) => void;
    private onResponseReady: ((text: string) => void) | undefined;
    private context: vscode.ExtensionContext;
    private currentSessionCode: string | null = null;
    private sseClients: Map<string, http.ServerResponse> = new Map();

    constructor(
        context: vscode.ExtensionContext,
        onTranscript: (transcript: string) => void
    ) {
        this.context = context;
        this.onTranscript = onTranscript;
        this.voiceService = new VoiceService();
    }

    /**
     * Set callback for when Claude's response is ready to be spoken
     */
    setResponseCallback(callback: (text: string) => void): void {
        this.onResponseReady = callback;
    }

    /**
     * Generate a random session code
     */
    private generateSessionCode(): string {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars (0,O,1,I)
        let code = '';
        for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    /**
     * Generate a secure session token
     */
    private generateToken(): string {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Create a new session and return the code
     */
    createSession(): string {
        // Clean up old sessions
        this.cleanupSessions();

        const code = this.generateSessionCode();
        const token = this.generateToken();

        const session: Session = {
            code,
            token,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            connected: false
        };

        this.sessions.set(code, session);
        this.currentSessionCode = code;

        console.log('Created voice bridge session:', code);
        return code;
    }

    /**
     * Clean up expired sessions
     */
    private cleanupSessions(): void {
        const now = Date.now();
        for (const [code, session] of this.sessions) {
            // Remove unconnected sessions after code expiry
            if (!session.connected && (now - session.createdAt) > SESSION_CODE_EXPIRY) {
                this.sessions.delete(code);
                console.log('Cleaned up expired unconnected session:', code);
            }
            // Remove inactive connected sessions
            if (session.connected && (now - session.lastActivity) > SESSION_TIMEOUT) {
                if (session.response) {
                    session.response.end();
                }
                this.sessions.delete(code);
                console.log('Cleaned up inactive session:', code);
            }
        }
    }

    /**
     * Get the URL for the voice bridge page
     */
    getVoiceBridgeUrl(): string {
        return `http://127.0.0.1:${BRIDGE_PORT}`;
    }

    /**
     * Get the external URL (handles Codespaces port forwarding)
     */
    async getExternalUrl(): Promise<string> {
        try {
            const localUri = vscode.Uri.parse(`http://127.0.0.1:${BRIDGE_PORT}`);
            const externalUri = await vscode.env.asExternalUri(localUri);
            return externalUri.toString();
        } catch {
            return this.getVoiceBridgeUrl();
        }
    }

    /**
     * Kill any existing process on the bridge port
     */
    private killExistingProcess(): void {
        try {
            const platform = process.platform;
            if (platform === 'darwin' || platform === 'linux') {
                // macOS/Linux: Use lsof to find and kill process
                execSync(`lsof -ti:${BRIDGE_PORT} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
            } else if (platform === 'win32') {
                // Windows: Use netstat and taskkill
                execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${BRIDGE_PORT}') do taskkill /F /PID %a 2>nul`, { stdio: 'ignore', shell: 'cmd.exe' });
            }
            console.log(`Cleared any existing process on port ${BRIDGE_PORT}`);
        } catch (e) {
            // Ignore errors - port might not be in use
        }
    }

    /**
     * Start the HTTP server with SSE support
     */
    start(): void {
        // Kill any existing process on the port first
        this.killExistingProcess();

        this.httpServer = http.createServer(async (req, res) => {
            // Enable CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Code, X-Session-Token');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            const url = new URL(req.url || '/', `http://${req.headers.host}`);

            if (url.pathname === '/' || url.pathname === '/index.html') {
                this.serveVoiceBridgePage(res);
            } else if (url.pathname === '/connect' && req.method === 'POST') {
                console.log('Connect request received, active sessions:', Array.from(this.sessions.keys()));
                await this.handleConnect(req, res);
            } else if (url.pathname === '/events' && req.method === 'GET') {
                this.handleSSE(req, res);
            } else if (url.pathname === '/audio' && req.method === 'POST') {
                await this.handleAudio(req, res);
            } else if (url.pathname === '/permission' && req.method === 'POST') {
                await this.handlePermission(req, res);
            } else if (url.pathname === '/status' && req.method === 'GET') {
                this.handleStatus(res);
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        let retryCount = 0;
        const maxRetries = 1;

        this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                if (retryCount < maxRetries) {
                    retryCount++;
                    console.error(`Voice bridge port ${BRIDGE_PORT} already in use. Will retry once after delay...`);
                    // Try once more after a longer delay
                    setTimeout(() => {
                        try {
                            this.httpServer?.listen(BRIDGE_PORT, '0.0.0.0');
                        } catch (e) {
                            console.error('Voice bridge server failed to start after retry');
                        }
                    }, 3000);
                } else {
                    console.error(`Voice bridge port ${BRIDGE_PORT} still in use. Please restart VS Code to free the port.`);
                    vscode.window.showWarningMessage(
                        'Voice bridge port is in use. Please restart VS Code or close other instances.',
                        'OK'
                    );
                }
            } else {
                console.error('Voice bridge server error:', err);
            }
        });

        this.httpServer.listen(BRIDGE_PORT, '0.0.0.0', () => {
            console.log(`Voice bridge server running on port ${BRIDGE_PORT}`);
        });
    }

    /**
     * Stop the server
     */
    stop(): void {
        // Close all SSE connections
        for (const [, res] of this.sseClients) {
            res.end();
        }
        this.sseClients.clear();
        this.httpServer?.close();
    }

    /**
     * Handle session connection
     */
    private async handleConnect(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const code = body.sessionCode?.toUpperCase();

                if (!code) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Session code required' }));
                    return;
                }

                const session = this.sessions.get(code);
                if (!session) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Invalid or expired session code' }));
                    return;
                }

                // Check if code has expired (for unconnected sessions)
                if (!session.connected && (Date.now() - session.createdAt) > SESSION_CODE_EXPIRY) {
                    this.sessions.delete(code);
                    res.writeHead(410, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Session code has expired' }));
                    return;
                }

                // Mark as connected
                session.connected = true;
                session.lastActivity = Date.now();

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    token: session.token,
                    message: 'Connected to VS Code!'
                }));

                console.log('Browser connected to session:', code);
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid request' }));
            }
        });
    }

    /**
     * Handle Server-Sent Events for real-time updates
     */
    private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        // Validate token
        let validSession: Session | undefined;
        for (const session of this.sessions.values()) {
            if (session.token === token && session.connected) {
                validSession = session;
                break;
            }
        }

        if (!validSession) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or expired session' }));
            return;
        }

        // Set up SSE
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // Store the response for sending events
        this.sseClients.set(validSession.token, res);
        validSession.response = res;

        // Send initial connected event
        this.sendSSEEvent(res, 'connected', { message: 'SSE connection established' });

        // Keep connection alive with heartbeat
        const heartbeat = setInterval(() => {
            if (!res.writableEnded) {
                this.sendSSEEvent(res, 'heartbeat', { time: Date.now() });
            } else {
                clearInterval(heartbeat);
            }
        }, 30000);

        // Handle disconnect
        req.on('close', () => {
            clearInterval(heartbeat);
            this.sseClients.delete(validSession!.token);
            console.log('SSE client disconnected');
        });
    }

    /**
     * Send an SSE event to a client
     */
    private sendSSEEvent(res: http.ServerResponse, event: string, data: any): void {
        if (!res.writableEnded) {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    }

    /**
     * Send event to all connected clients for a session
     */
    sendToSession(sessionCode: string, event: string, data: any): void {
        const session = this.sessions.get(sessionCode);
        if (session && session.response && !session.response.writableEnded) {
            this.sendSSEEvent(session.response, event, data);
        }
    }

    /**
     * Send Claude's response to be spoken in browser (legacy non-streaming)
     */
    sendTTSResponse(text: string): void {
        if (this.currentSessionCode) {
            const session = this.sessions.get(this.currentSessionCode);
            if (session && session.connected) {
                // Get TTS audio and send to browser
                this.voiceService.synthesize(text).then(audioBuffer => {
                    if (audioBuffer) {
                        const base64Audio = audioBuffer.toString('base64');
                        this.sendToSession(this.currentSessionCode!, 'tts', {
                            audio: base64Audio,
                            mimeType: 'audio/mp3',
                            text: text,
                            isStreaming: false,
                            isLast: true
                        });
                    }
                }).catch(err => {
                    console.error('TTS error:', err);
                    // Send text only if TTS fails
                    this.sendToSession(this.currentSessionCode!, 'response', { text });
                });
            }
        }
    }

    /**
     * Send streaming audio chunk to browser (called by StreamingTTSManager)
     */
    sendStreamingAudio(audioBase64: string, text: string, isLast: boolean): void {
        if (this.currentSessionCode) {
            const session = this.sessions.get(this.currentSessionCode);
            if (session && session.connected) {
                this.sendToSession(this.currentSessionCode, 'tts', {
                    audio: audioBase64,
                    mimeType: 'audio/mp3',
                    text: text,
                    isStreaming: true,
                    isLast: isLast
                });
            }
        }
    }

    /**
     * Send playback state change to browser
     */
    sendPlaybackState(state: string): void {
        if (this.currentSessionCode) {
            const session = this.sessions.get(this.currentSessionCode);
            if (session && session.connected) {
                this.sendToSession(this.currentSessionCode, 'playbackState', {
                    state: state
                });
            }
        }
    }

    /**
     * Check if there's an active session connected
     */
    hasActiveSession(): boolean {
        if (!this.currentSessionCode) return false;
        const session = this.sessions.get(this.currentSessionCode);
        return !!(session && session.connected);
    }

    /**
     * Send permission request to browser for voice/button approval
     */
    sendPermissionRequest(request: {
        id: string;
        tool: string;
        prompt: string;
        input: Record<string, unknown>;
        pattern?: string;
    }): void {
        if (this.currentSessionCode) {
            const session = this.sessions.get(this.currentSessionCode);
            if (session && session.connected) {
                // Track pending permission for voice responses
                this.pendingPermissionId = request.id;

                // Send permission request event
                this.sendToSession(this.currentSessionCode, 'permissionRequest', {
                    id: request.id,
                    tool: request.tool,
                    prompt: request.prompt,
                    input: request.input,
                    pattern: request.pattern
                });

                // Also speak the permission request via TTS
                this.voiceService.synthesize(request.prompt + '. Say yes to allow or no to deny.')
                    .then(audioBuffer => {
                        if (audioBuffer) {
                            const base64Audio = audioBuffer.toString('base64');
                            this.sendToSession(this.currentSessionCode!, 'tts', {
                                audio: base64Audio,
                                mimeType: 'audio/mp3',
                                text: request.prompt,
                                isPermission: true
                            });
                        }
                    })
                    .catch(err => console.error('Permission TTS error:', err));
            }
        }
    }

    /**
     * Handle permission response from browser
     */
    private handlePermissionResponse(approved: boolean, requestId: string, alwaysAllow: boolean = false): void {
        // Forward to the callback that was set
        if (this.onPermissionResponse) {
            this.onPermissionResponse(requestId, approved, alwaysAllow);
        }
    }

    /**
     * Callback for permission responses
     */
    private onPermissionResponse?: (requestId: string, approved: boolean, alwaysAllow: boolean) => void;

    /**
     * Set callback for handling permission responses from browser
     */
    setPermissionResponseCallback(callback: (requestId: string, approved: boolean, alwaysAllow: boolean) => void): void {
        this.onPermissionResponse = callback;
    }

    /**
     * Handle audio upload from browser
     */
    private async handleAudio(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const token = req.headers['x-session-token'] as string;

        // Validate token
        let validSession: Session | undefined;
        for (const session of this.sessions.values()) {
            if (session.token === token && session.connected) {
                validSession = session;
                break;
            }
        }

        if (!validSession) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or expired session' }));
            return;
        }

        validSession.lastActivity = Date.now();

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const audioBuffer = Buffer.from(body.audio, 'base64');
                const mimeType = body.mimeType || 'audio/webm';

                console.log('Received audio from browser, size:', audioBuffer.length);

                // Transcribe
                const transcript = await this.voiceService.transcribe(audioBuffer, mimeType);
                console.log('Transcribed:', transcript);

                // Send transcript event
                this.sendToSession(validSession!.code, 'transcript', { text: transcript });

                // Check if this is a permission response (yes/no) before sending to Claude
                if (this.checkForPermissionResponse(transcript)) {
                    console.log('Handled as permission response');
                    // Clear permission UI in browser
                    this.sendToSession(validSession!.code, 'permissionHandled', { handled: true });

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, transcript, isPermissionResponse: true }));
                    return;
                }

                // Send to Claude via callback
                this.onTranscript(transcript);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, transcript }));
            } catch (error) {
                console.error('Audio processing error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error instanceof Error ? error.message : 'Processing error'
                }));
            }
        });
    }

    /**
     * Handle permission response from browser (button click or voice)
     */
    private async handlePermission(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const token = req.headers['x-session-token'] as string;

        // Validate token
        let validSession: Session | undefined;
        for (const session of this.sessions.values()) {
            if (session.token === token && session.connected) {
                validSession = session;
                break;
            }
        }

        if (!validSession) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or expired session' }));
            return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                const { requestId, approved, alwaysAllow } = body;

                console.log('Permission response from browser:', { requestId, approved, alwaysAllow });

                // Forward to the callback
                this.handlePermissionResponse(approved, requestId, alwaysAllow || false);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request' }));
            }
        });
    }

    /**
     * Track pending permission request ID for voice responses
     */
    private pendingPermissionId: string | null = null;

    /**
     * Check if transcript is a permission response (yes/no)
     */
    private checkForPermissionResponse(transcript: string): boolean {
        if (!this.pendingPermissionId) return false;

        const lower = transcript.toLowerCase().trim();

        // Check for approval phrases
        const approvalPhrases = ['yes', 'yeah', 'yep', 'approve', 'allow', 'go ahead', 'do it', 'okay', 'ok'];
        const denialPhrases = ['no', 'nope', 'deny', 'stop', 'cancel', 'don\'t', 'reject'];

        const isApproval = approvalPhrases.some(phrase => lower.includes(phrase));
        const isDenial = denialPhrases.some(phrase => lower.includes(phrase));

        if (isApproval && !isDenial) {
            console.log('Voice permission approved:', this.pendingPermissionId);
            this.handlePermissionResponse(true, this.pendingPermissionId, false);
            this.pendingPermissionId = null;
            return true;
        } else if (isDenial && !isApproval) {
            console.log('Voice permission denied:', this.pendingPermissionId);
            this.handlePermissionResponse(false, this.pendingPermissionId, false);
            this.pendingPermissionId = null;
            return true;
        }

        return false;
    }

    /**
     * Handle status check
     */
    private handleStatus(res: http.ServerResponse): void {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'running',
            sessions: this.sessions.size,
            currentSession: this.currentSessionCode
        }));
    }

    /**
     * Serve the voice bridge HTML page
     */
    private serveVoiceBridgePage(res: http.ServerResponse): void {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Code Voice Bridge</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 100%);
            color: #fff;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            text-align: center;
            max-width: 500px;
            width: 100%;
        }
        h1 {
            font-size: 28px;
            margin-bottom: 10px;
            background: linear-gradient(90deg, #64ffda, #00bcd4);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle {
            color: #8892b0;
            margin-bottom: 30px;
        }

        /* Connection Phase */
        .connect-section {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 16px;
            padding: 30px;
            margin-bottom: 20px;
        }
        .code-input {
            display: flex;
            gap: 8px;
            justify-content: center;
            margin: 20px 0;
        }
        .code-input input {
            width: 45px;
            height: 55px;
            text-align: center;
            font-size: 24px;
            font-weight: bold;
            border: 2px solid rgba(100, 255, 218, 0.3);
            border-radius: 8px;
            background: rgba(0, 0, 0, 0.3);
            color: #64ffda;
            text-transform: uppercase;
        }
        .code-input input:focus {
            outline: none;
            border-color: #64ffda;
            box-shadow: 0 0 10px rgba(100, 255, 218, 0.3);
        }
        .connect-btn {
            background: linear-gradient(145deg, #64ffda, #00bcd4);
            color: #0f0f23;
            border: none;
            padding: 12px 40px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 25px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .connect-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 5px 20px rgba(100, 255, 218, 0.4);
        }
        .connect-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        /* Voice Phase */
        .voice-section {
            display: none;
        }
        .voice-section.active {
            display: block;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: rgba(100, 255, 218, 0.1);
            border: 1px solid rgba(100, 255, 218, 0.3);
            padding: 8px 16px;
            border-radius: 20px;
            margin-bottom: 30px;
        }
        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #64ffda;
            animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .mic-button {
            width: 100px;
            height: 100px;
            border-radius: 50%;
            border: none;
            background: linear-gradient(145deg, #e94560, #c73e54);
            color: white;
            font-size: 40px;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 10px 30px rgba(233, 69, 96, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 20px;
        }
        .mic-button:hover {
            transform: scale(1.05);
        }
        .mic-button.recording {
            animation: recording-pulse 1.5s ease-in-out infinite;
            background: linear-gradient(145deg, #ff6b6b, #e94560);
        }
        @keyframes recording-pulse {
            0%, 100% { transform: scale(1); box-shadow: 0 10px 30px rgba(233, 69, 96, 0.3); }
            50% { transform: scale(1.1); box-shadow: 0 15px 50px rgba(233, 69, 96, 0.5); }
        }
        .mic-button.processing {
            background: linear-gradient(145deg, #ffd93d, #f0c929);
            animation: none;
        }
        .voice-status {
            color: #ccd6f6;
            margin-bottom: 20px;
            min-height: 24px;
            font-size: 16px;
        }

        /* Playback Controls */
        .playback-controls {
            display: flex;
            gap: 12px;
            justify-content: center;
            margin-bottom: 20px;
        }
        .control-btn {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            border: 2px solid rgba(255, 255, 255, 0.2);
            background: rgba(255, 255, 255, 0.1);
            color: white;
            font-size: 20px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .control-btn:hover {
            background: rgba(255, 255, 255, 0.2);
            border-color: rgba(255, 255, 255, 0.4);
        }
        .control-btn:active {
            transform: scale(0.95);
        }
        .control-btn.stop {
            border-color: rgba(233, 69, 96, 0.5);
        }
        .control-btn.stop:hover {
            background: rgba(233, 69, 96, 0.3);
            border-color: rgba(233, 69, 96, 0.7);
        }

        /* Audio Queue Status */
        .queue-status {
            font-size: 12px;
            color: #8892b0;
            margin-bottom: 15px;
            min-height: 18px;
        }
        .queue-status.active {
            color: #64ffda;
        }

        /* Mobile Optimizations */
        @media (max-width: 480px) {
            body {
                padding: 15px;
            }
            h1 {
                font-size: 24px;
            }
            .code-input input {
                width: 40px;
                height: 50px;
                font-size: 20px;
            }
            .mic-button {
                width: 120px;
                height: 120px;
                font-size: 48px;
            }
            .control-btn {
                width: 56px;
                height: 56px;
                font-size: 24px;
            }
            .chat-container {
                max-height: 200px;
            }
        }

        /* Larger touch targets for mobile */
        @media (hover: none) and (pointer: coarse) {
            .mic-button {
                width: 130px;
                height: 130px;
            }
            .control-btn {
                width: 60px;
                height: 60px;
            }
        }

        /* Chat Display */
        .chat-container {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 15px;
            max-height: 300px;
            overflow-y: auto;
            text-align: left;
            margin-top: 20px;
        }
        .chat-message {
            padding: 10px 15px;
            margin-bottom: 10px;
            border-radius: 12px;
            animation: fadeIn 0.3s ease;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .chat-message.user {
            background: rgba(100, 255, 218, 0.1);
            border-left: 3px solid #64ffda;
        }
        .chat-message.assistant {
            background: rgba(233, 69, 96, 0.1);
            border-left: 3px solid #e94560;
        }
        .chat-message .label {
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
            opacity: 0.6;
            margin-bottom: 5px;
        }
        .chat-message .text {
            line-height: 1.5;
        }

        .error {
            color: #ff6b6b;
            background: rgba(255, 107, 107, 0.1);
            padding: 10px 20px;
            border-radius: 8px;
            margin-top: 15px;
        }
        .hidden { display: none !important; }

        /* Permission Request UI */
        .permission-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            animation: fadeIn 0.2s ease;
        }
        .permission-card {
            background: linear-gradient(145deg, #1e1e3f, #2a2a5a);
            border: 2px solid #ffd93d;
            border-radius: 16px;
            padding: 24px;
            max-width: 400px;
            width: 90%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(255, 217, 61, 0.2);
        }
        .permission-icon {
            font-size: 48px;
            margin-bottom: 16px;
        }
        .permission-title {
            font-size: 18px;
            color: #ffd93d;
            margin-bottom: 8px;
            font-weight: 600;
        }
        .permission-tool {
            font-size: 14px;
            color: #8892b0;
            margin-bottom: 16px;
        }
        .permission-prompt {
            font-size: 16px;
            color: #ccd6f6;
            margin-bottom: 20px;
            line-height: 1.5;
            background: rgba(0, 0, 0, 0.3);
            padding: 12px;
            border-radius: 8px;
            word-break: break-word;
        }
        .permission-buttons {
            display: flex;
            gap: 12px;
            justify-content: center;
            flex-wrap: wrap;
        }
        .permission-btn {
            padding: 12px 28px;
            font-size: 16px;
            font-weight: 600;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        .permission-btn.approve {
            background: linear-gradient(145deg, #64ffda, #00bcd4);
            color: #0f0f23;
        }
        .permission-btn.approve:hover {
            transform: scale(1.05);
            box-shadow: 0 5px 20px rgba(100, 255, 218, 0.4);
        }
        .permission-btn.deny {
            background: linear-gradient(145deg, #e94560, #c73e54);
            color: white;
        }
        .permission-btn.deny:hover {
            transform: scale(1.05);
            box-shadow: 0 5px 20px rgba(233, 69, 96, 0.4);
        }
        .permission-hint {
            font-size: 12px;
            color: #8892b0;
            margin-top: 16px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Claude Code Voice</h1>
        <p class="subtitle">Persistent Voice Bridge</p>

        <!-- Connection Phase -->
        <div class="connect-section" id="connectSection">
            <p style="color: #ccd6f6; margin-bottom: 15px;">Enter the session code from VS Code:</p>
            <div class="code-input" id="codeInput">
                <input type="text" maxlength="1" data-index="0" autofocus>
                <input type="text" maxlength="1" data-index="1">
                <input type="text" maxlength="1" data-index="2">
                <input type="text" maxlength="1" data-index="3">
                <input type="text" maxlength="1" data-index="4">
                <input type="text" maxlength="1" data-index="5">
            </div>
            <button class="connect-btn" id="connectBtn">Connect</button>
            <div class="error hidden" id="connectError"></div>
        </div>

        <!-- Voice Phase -->
        <div class="voice-section" id="voiceSection">
            <div class="status-badge">
                <div class="status-dot"></div>
                <span>Connected to VS Code</span>
            </div>

            <button class="mic-button" id="micButton">
                <span id="micIcon">🎤</span>
            </button>
            <div class="voice-status" id="voiceStatus">Click or press Space to speak</div>
            <div class="queue-status" id="queueStatus"></div>

            <div class="playback-controls">
                <button class="control-btn stop" id="stopBtn" title="Stop playback">⏹</button>
            </div>

            <div class="chat-container" id="chatContainer"></div>
        </div>

        <!-- Permission Request Overlay -->
        <div class="permission-overlay hidden" id="permissionOverlay">
            <div class="permission-card">
                <div class="permission-icon">⚠️</div>
                <div class="permission-title">Permission Required</div>
                <div class="permission-tool" id="permissionTool">Tool: Bash</div>
                <div class="permission-prompt" id="permissionPrompt">Run command: ls -la</div>
                <div class="permission-buttons">
                    <button class="permission-btn approve" id="permissionApprove">✓ Allow</button>
                    <button class="permission-btn deny" id="permissionDeny">✗ Deny</button>
                </div>
                <div class="permission-hint">Or say "yes" / "no" to respond by voice</div>
            </div>
        </div>
    </div>

    <script>
        let sessionToken = null;
        let eventSource = null;
        let mediaRecorder = null;
        let audioChunks = [];
        let isRecording = false;
        let audioContext = null;
        let analyser = null;
        let currentPermissionId = null;

        // Audio queue for streaming TTS
        let audioQueue = [];
        let isPlayingAudio = false;
        let currentAudioElement = null;

        // DOM elements
        const connectSection = document.getElementById('connectSection');
        const voiceSection = document.getElementById('voiceSection');
        const codeInputs = document.querySelectorAll('.code-input input');
        const connectBtn = document.getElementById('connectBtn');
        const connectError = document.getElementById('connectError');
        const micButton = document.getElementById('micButton');
        const micIcon = document.getElementById('micIcon');
        const voiceStatus = document.getElementById('voiceStatus');
        const chatContainer = document.getElementById('chatContainer');

        // Permission elements
        const permissionOverlay = document.getElementById('permissionOverlay');
        const permissionTool = document.getElementById('permissionTool');
        const permissionPrompt = document.getElementById('permissionPrompt');
        const permissionApprove = document.getElementById('permissionApprove');
        const permissionDeny = document.getElementById('permissionDeny');

        // Playback control elements
        const stopBtn = document.getElementById('stopBtn');
        const queueStatusEl = document.getElementById('queueStatus');

        // Handle code input navigation
        codeInputs.forEach((input, index) => {
            input.addEventListener('input', (e) => {
                const value = e.target.value.toUpperCase();
                e.target.value = value;
                if (value && index < codeInputs.length - 1) {
                    codeInputs[index + 1].focus();
                }
                checkCodeComplete();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value && index > 0) {
                    codeInputs[index - 1].focus();
                }
                if (e.key === 'Enter') {
                    connect();
                }
            });
            input.addEventListener('paste', (e) => {
                e.preventDefault();
                const paste = e.clipboardData.getData('text').toUpperCase().slice(0, 6);
                paste.split('').forEach((char, i) => {
                    if (codeInputs[i]) codeInputs[i].value = char;
                });
                checkCodeComplete();
            });
        });

        function checkCodeComplete() {
            const code = Array.from(codeInputs).map(i => i.value).join('');
            connectBtn.disabled = code.length !== 6;
        }

        function getCode() {
            return Array.from(codeInputs).map(i => i.value).join('');
        }

        // Connect to session
        connectBtn.addEventListener('click', connect);

        async function connect() {
            const code = getCode();
            if (code.length !== 6) return;

            connectBtn.disabled = true;
            connectBtn.textContent = 'Connecting...';
            connectError.classList.add('hidden');

            try {
                const response = await fetch('/connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionCode: code })
                });

                const result = await response.json();

                if (result.success) {
                    sessionToken = result.token;
                    // Save to localStorage for auto-reconnect
                    localStorage.setItem('voiceBridgeCode', code);
                    localStorage.setItem('voiceBridgeToken', result.token);
                    connectSection.classList.add('hidden');
                    voiceSection.classList.add('active');
                    setupSSE();
                } else {
                    // Clear saved session on failure
                    localStorage.removeItem('voiceBridgeCode');
                    localStorage.removeItem('voiceBridgeToken');
                    showConnectError(result.error || 'Connection failed');
                }
            } catch (error) {
                showConnectError('Network error: ' + error.message);
            }

            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect';
        }

        function showConnectError(message) {
            connectError.textContent = message;
            connectError.classList.remove('hidden');
        }

        // Setup Server-Sent Events
        function setupSSE() {
            eventSource = new EventSource('/events?token=' + sessionToken);

            eventSource.addEventListener('connected', (e) => {
                console.log('SSE connected');
            });

            eventSource.addEventListener('transcript', (e) => {
                const data = JSON.parse(e.data);
                addChatMessage('user', data.text);
            });

            eventSource.addEventListener('response', (e) => {
                const data = JSON.parse(e.data);
                addChatMessage('assistant', data.text);
            });

            eventSource.addEventListener('tts', async (e) => {
                const data = JSON.parse(e.data);
                // Don't duplicate permission prompts in chat
                if (!data.isPermission) {
                    addChatMessage('assistant', data.text);
                }

                // Queue audio for playback
                if (data.audio) {
                    queueAudio(data.audio, data.mimeType || 'audio/mp3', data.isPermission, data.isLast);
                }
            });

            // Handle permission request from VS Code
            eventSource.addEventListener('permissionRequest', (e) => {
                const data = JSON.parse(e.data);
                console.log('Permission request received:', data);
                showPermission(data);
            });

            // Handle permission handled (via voice)
            eventSource.addEventListener('permissionHandled', (e) => {
                console.log('Permission handled via voice');
                hidePermission();
            });

            // Handle playback control from server
            eventSource.addEventListener('playbackState', (e) => {
                const data = JSON.parse(e.data);
                console.log('Playback state:', data.state);
                if (data.state === 'stopped') {
                    stopAudioQueue();
                } else if (data.state === 'paused') {
                    if (currentAudioElement) currentAudioElement.pause();
                } else if (data.state === 'playing') {
                    if (currentAudioElement) currentAudioElement.play();
                }
            });

            eventSource.addEventListener('error', (e) => {
                console.error('SSE error', e);
                if (voiceStatus) voiceStatus.textContent = 'Connection lost. Attempting to reconnect...';
                // Try to reconnect after a short delay
                setTimeout(() => {
                    tryAutoReconnect().then(reconnected => {
                        if (!reconnected) {
                            if (voiceStatus) voiceStatus.textContent = 'Connection lost. Please enter a new code.';
                            // Show connect section again
                            if (connectSection) connectSection.classList.remove('hidden');
                            if (voiceSection) voiceSection.classList.remove('active');
                        }
                    });
                }, 2000);
            });
        }

        function addChatMessage(role, text) {
            const div = document.createElement('div');
            div.className = 'chat-message ' + role;
            div.innerHTML = '<div class="label">' + (role === 'user' ? 'You' : 'Claude') + '</div><div class="text">' + text + '</div>';
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        // Audio queue management for streaming TTS
        function queueAudio(base64Audio, mimeType, isPermission, isLast) {
            audioQueue.push({ base64Audio, mimeType, isPermission, isLast });
            console.log('Queued audio, queue length:', audioQueue.length);
            updateQueueStatus();
            if (!isPlayingAudio) {
                playNextAudio();
            }
        }

        function playNextAudio() {
            if (audioQueue.length === 0) {
                isPlayingAudio = false;
                updateQueueStatus();
                if (!currentPermissionId && voiceStatus) {
                    voiceStatus.textContent = 'Click or press Space to speak';
                }
                return;
            }

            isPlayingAudio = true;
            const item = audioQueue.shift();
            updateQueueStatus();

            try {
                const audioData = atob(item.base64Audio);
                const audioArray = new Uint8Array(audioData.length);
                for (let i = 0; i < audioData.length; i++) {
                    audioArray[i] = audioData.charCodeAt(i);
                }
                const audioBlob = new Blob([audioArray], { type: item.mimeType });
                const audioUrl = URL.createObjectURL(audioBlob);
                currentAudioElement = new Audio(audioUrl);

                if (voiceStatus) voiceStatus.textContent = item.isPermission ? 'Permission requested...' : 'Playing response...';

                currentAudioElement.onended = () => {
                    URL.revokeObjectURL(audioUrl);
                    currentAudioElement = null;
                    // Play next in queue
                    playNextAudio();
                };

                currentAudioElement.onerror = (err) => {
                    console.error('Audio playback error:', err);
                    URL.revokeObjectURL(audioUrl);
                    currentAudioElement = null;
                    // Try next audio
                    playNextAudio();
                };

                currentAudioElement.play();
            } catch (err) {
                console.error('Audio processing error:', err);
                playNextAudio();
            }
        }

        function stopAudioQueue() {
            audioQueue = [];
            if (currentAudioElement) {
                currentAudioElement.pause();
                currentAudioElement = null;
            }
            isPlayingAudio = false;
            updateQueueStatus();
            if (voiceStatus) voiceStatus.textContent = 'Click or press Space to speak';
        }

        // Permission handling
        function showPermission(data) {
            currentPermissionId = data.id;
            if (permissionTool) permissionTool.textContent = 'Tool: ' + data.tool;
            if (permissionPrompt) permissionPrompt.textContent = data.prompt;
            if (permissionOverlay) permissionOverlay.classList.remove('hidden');
            if (voiceStatus) voiceStatus.textContent = 'Permission required - respond by voice or buttons';
        }

        function hidePermission() {
            currentPermissionId = null;
            if (permissionOverlay) permissionOverlay.classList.add('hidden');
            if (voiceStatus) voiceStatus.textContent = 'Click or press Space to speak';
        }

        async function sendPermissionResponse(approved) {
            if (!currentPermissionId) return;

            try {
                await fetch('/permission', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Session-Token': sessionToken
                    },
                    body: JSON.stringify({
                        requestId: currentPermissionId,
                        approved: approved,
                        alwaysAllow: false
                    })
                });
                hidePermission();
            } catch (error) {
                console.error('Permission response error:', error);
            }
        }

        // Permission button handlers
        if (permissionApprove) {
            permissionApprove.addEventListener('click', () => sendPermissionResponse(true));
        }
        if (permissionDeny) {
            permissionDeny.addEventListener('click', () => sendPermissionResponse(false));
        }

        // Stop button handler
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                stopAudioQueue();
            });
        }

        // Update queue status display
        function updateQueueStatus() {
            if (!queueStatusEl) return;
            if (audioQueue.length > 0) {
                queueStatusEl.textContent = 'Audio queue: ' + (audioQueue.length + (isPlayingAudio ? 1 : 0)) + ' items';
                queueStatusEl.classList.add('active');
            } else if (isPlayingAudio) {
                queueStatusEl.textContent = 'Playing...';
                queueStatusEl.classList.add('active');
            } else {
                queueStatusEl.textContent = '';
                queueStatusEl.classList.remove('active');
            }
        }

        // Voice recording
        micButton.addEventListener('click', toggleRecording);

        async function toggleRecording() {
            if (isRecording) {
                stopRecording();
            } else {
                await startRecording();
            }
        }

        async function startRecording() {
            // Interrupt any playing audio when user starts speaking
            stopAudioQueue();

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true }
                });

                // Detect best supported audio format (Safari/iOS needs mp4, others prefer webm)
                let mimeType = 'audio/webm';
                const formats = [
                    'audio/webm;codecs=opus',
                    'audio/webm',
                    'audio/mp4',
                    'audio/mp4;codecs=mp4a.40.2',
                    'audio/ogg;codecs=opus',
                    'audio/wav'
                ];
                for (const format of formats) {
                    if (MediaRecorder.isTypeSupported(format)) {
                        mimeType = format;
                        break;
                    }
                }
                console.log('Using audio format:', mimeType);

                mediaRecorder = new MediaRecorder(stream, { mimeType });
                audioChunks = [];

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) audioChunks.push(e.data);
                };

                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: mimeType });
                    stream.getTracks().forEach(t => t.stop());
                    await sendAudio(audioBlob, mimeType);
                };

                mediaRecorder.start();
                isRecording = true;
                if (micButton) micButton.classList.add('recording');
                if (micIcon) micIcon.textContent = '⏹';
                if (voiceStatus) voiceStatus.textContent = 'Listening... Click to stop';

            } catch (error) {
                if (voiceStatus) voiceStatus.textContent = 'Microphone access denied';
            }
        }

        function stopRecording() {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
                isRecording = false;
                if (micButton) {
                    micButton.classList.remove('recording');
                    micButton.classList.add('processing');
                }
                if (micIcon) micIcon.textContent = '⏳';
                if (voiceStatus) voiceStatus.textContent = 'Processing...';
            }
        }

        async function sendAudio(audioBlob, mimeType) {
            try {
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64 = reader.result.split(',')[1];

                    const response = await fetch('/audio', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Session-Token': sessionToken
                        },
                        body: JSON.stringify({ audio: base64, mimeType })
                    });

                    const result = await response.json();

                    if (micButton) micButton.classList.remove('processing');
                    if (micIcon) micIcon.textContent = '🎤';

                    if (result.success) {
                        if (voiceStatus) voiceStatus.textContent = 'Waiting for Claude...';
                    } else {
                        if (voiceStatus) voiceStatus.textContent = 'Error: ' + (result.error || 'Processing failed');
                    }
                };
                reader.readAsDataURL(audioBlob);
            } catch (error) {
                if (voiceStatus) voiceStatus.textContent = 'Network error: ' + error.message;
                if (micButton) micButton.classList.remove('processing');
                if (micIcon) micIcon.textContent = '🎤';
            }
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (voiceSection && voiceSection.classList.contains('active')) {
                if (e.code === 'Space' && !isRecording) {
                    e.preventDefault();
                    startRecording();
                } else if (e.code === 'Space' && isRecording) {
                    e.preventDefault();
                    stopRecording();
                }
            }
        });

        // Auto-reconnect on page load if we have a saved session
        async function tryAutoReconnect() {
            const savedCode = localStorage.getItem('voiceBridgeCode');
            const savedToken = localStorage.getItem('voiceBridgeToken');

            if (savedCode && savedToken) {
                console.log('Attempting auto-reconnect with saved session');
                connectBtn.textContent = 'Reconnecting...';
                connectBtn.disabled = true;

                // Pre-fill the code inputs
                savedCode.split('').forEach((char, i) => {
                    if (codeInputs[i]) codeInputs[i].value = char;
                });

                try {
                    const response = await fetch('/connect', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionCode: savedCode })
                    });

                    const result = await response.json();

                    if (result.success) {
                        sessionToken = result.token;
                        localStorage.setItem('voiceBridgeToken', result.token);
                        connectSection.classList.add('hidden');
                        voiceSection.classList.add('active');
                        setupSSE();
                        console.log('Auto-reconnect successful!');
                        return true;
                    }
                } catch (e) {
                    console.log('Auto-reconnect failed:', e);
                }

                // Auto-reconnect failed, clear saved session
                localStorage.removeItem('voiceBridgeCode');
                localStorage.removeItem('voiceBridgeToken');
                connectBtn.textContent = 'Connect';
                connectBtn.disabled = false;
                showConnectError('Session expired. Please enter a new code from VS Code.');
            }
            return false;
        }

        // Try auto-reconnect on load (wait for DOM to be ready)
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryAutoReconnect);
        } else {
            tryAutoReconnect();
        }
    </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    }

    /**
     * Open the voice bridge in browser with current session
     */
    async openVoiceBridge(): Promise<string> {
        const code = this.createSession();
        // Use VS Code's API for proper Codespaces/remote URL handling
        const url = await this.getExternalUrl();
        console.log('Opening voice bridge at:', url);
        vscode.env.openExternal(vscode.Uri.parse(url));
        return code;
    }
}
