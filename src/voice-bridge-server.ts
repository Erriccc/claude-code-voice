/**
 * VoiceBridgeServer - WebSocket-based persistent browser voice mode
 *
 * Enables continuous voice interaction through a browser tab that stays open.
 * Used for Codespaces, VS Code Web, and other environments where native audio isn't available.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
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
        const isCodespaces = process.env.CODESPACES === 'true';
        const codespaceName = process.env.CODESPACE_NAME;
        const githubCodespacesPortForwardingDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;

        if (isCodespaces && codespaceName && githubCodespacesPortForwardingDomain) {
            return `https://${codespaceName}-${BRIDGE_PORT}.${githubCodespacesPortForwardingDomain}`;
        }
        return `http://127.0.0.1:${BRIDGE_PORT}`;
    }

    /**
     * Start the HTTP server with SSE support
     */
    start(): void {
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
                await this.handleConnect(req, res);
            } else if (url.pathname === '/events' && req.method === 'GET') {
                this.handleSSE(req, res);
            } else if (url.pathname === '/audio' && req.method === 'POST') {
                await this.handleAudio(req, res);
            } else if (url.pathname === '/status' && req.method === 'GET') {
                this.handleStatus(res);
            } else {
                res.writeHead(404);
                res.end('Not found');
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
     * Send Claude's response to be spoken in browser
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
                            text: text
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
            <div class="voice-status" id="voiceStatus">Click to start speaking</div>

            <div class="chat-container" id="chatContainer"></div>
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
                    connectSection.classList.add('hidden');
                    voiceSection.classList.add('active');
                    setupSSE();
                } else {
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
                addChatMessage('assistant', data.text);

                // Play audio
                if (data.audio) {
                    try {
                        const audioData = atob(data.audio);
                        const audioArray = new Uint8Array(audioData.length);
                        for (let i = 0; i < audioData.length; i++) {
                            audioArray[i] = audioData.charCodeAt(i);
                        }
                        const audioBlob = new Blob([audioArray], { type: data.mimeType || 'audio/mp3' });
                        const audioUrl = URL.createObjectURL(audioBlob);
                        const audio = new Audio(audioUrl);
                        audio.play();
                        voiceStatus.textContent = 'Playing response...';
                        audio.onended = () => {
                            voiceStatus.textContent = 'Click to start speaking';
                            URL.revokeObjectURL(audioUrl);
                        };
                    } catch (err) {
                        console.error('Audio playback error:', err);
                    }
                }
            });

            eventSource.addEventListener('error', (e) => {
                console.error('SSE error', e);
                voiceStatus.textContent = 'Connection lost. Refresh to reconnect.';
            });
        }

        function addChatMessage(role, text) {
            const div = document.createElement('div');
            div.className = 'chat-message ' + role;
            div.innerHTML = '<div class="label">' + (role === 'user' ? 'You' : 'Claude') + '</div><div class="text">' + text + '</div>';
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
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
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true }
                });

                const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus' : 'audio/webm';

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
                micButton.classList.add('recording');
                micIcon.textContent = '⏹';
                voiceStatus.textContent = 'Listening... Click to stop';

            } catch (error) {
                voiceStatus.textContent = 'Microphone access denied';
            }
        }

        function stopRecording() {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
                isRecording = false;
                micButton.classList.remove('recording');
                micButton.classList.add('processing');
                micIcon.textContent = '⏳';
                voiceStatus.textContent = 'Processing...';
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

                    micButton.classList.remove('processing');
                    micIcon.textContent = '🎤';

                    if (result.success) {
                        voiceStatus.textContent = 'Waiting for Claude...';
                    } else {
                        voiceStatus.textContent = 'Error: ' + (result.error || 'Processing failed');
                    }
                };
                reader.readAsDataURL(audioBlob);
            } catch (error) {
                voiceStatus.textContent = 'Network error: ' + error.message;
                micButton.classList.remove('processing');
                micIcon.textContent = '🎤';
            }
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (voiceSection.classList.contains('active')) {
                if (e.code === 'Space' && !isRecording) {
                    e.preventDefault();
                    startRecording();
                } else if (e.code === 'Space' && isRecording) {
                    e.preventDefault();
                    stopRecording();
                }
            }
        });
    </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    }

    /**
     * Open the voice bridge in browser with current session
     */
    openVoiceBridge(): string {
        const code = this.createSession();
        const url = this.getVoiceBridgeUrl();
        vscode.env.openExternal(vscode.Uri.parse(url));
        return code;
    }
}
