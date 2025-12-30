import * as vscode from 'vscode';
import * as http from 'http';
import { VoiceService } from './voice-service';

const POPUP_PORT = 9876;

interface WebSocketLike {
    send(data: string): void;
    close(): void;
    readyState: number;
    OPEN: number;
}

export class VoicePopupServer {
    private httpServer: http.Server | undefined;
    private voiceService: VoiceService;
    private onTranscript: (transcript: string) => void;
    private context: vscode.ExtensionContext;
    private pendingResponses: Map<string, http.ServerResponse> = new Map();
    private webviewCallback: ((text: string) => void) | undefined;

    constructor(
        context: vscode.ExtensionContext,
        onTranscript: (transcript: string) => void
    ) {
        this.context = context;
        this.onTranscript = onTranscript;
        this.voiceService = new VoiceService();
    }

    setWebviewCallback(callback: (text: string) => void): void {
        this.webviewCallback = callback;
    }

    start(): void {
        this.httpServer = http.createServer(async (req, res) => {
            // Enable CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.url === '/' || req.url === '/index.html') {
                this.serveVoiceCapturePage(res);
            } else if (req.url === '/transcribe' && req.method === 'POST') {
                await this.handleTranscription(req, res);
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });

        this.httpServer.listen(POPUP_PORT, '127.0.0.1', () => {
            console.log(`Voice capture server running at http://127.0.0.1:${POPUP_PORT}`);
        });
    }

    stop(): void {
        this.httpServer?.close();
    }

    openVoiceCapture(): void {
        const url = `http://127.0.0.1:${POPUP_PORT}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }

    private async handleTranscription(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });

        req.on('end', async () => {
            try {
                const body = Buffer.concat(chunks);
                const data = JSON.parse(body.toString());

                // Decode base64 audio
                const audioBuffer = Buffer.from(data.audio, 'base64');
                const mimeType = data.mimeType || 'audio/webm';

                // Transcribe
                const transcript = await this.voiceService.transcribe(audioBuffer, mimeType);

                // Send transcript to callback
                this.onTranscript(transcript);

                // Also notify webview if callback is set
                if (this.webviewCallback) {
                    this.webviewCallback(transcript);
                }

                // Send response
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, text: transcript }));
            } catch (error) {
                console.error('Transcription error:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error'
                }));
            }
        });
    }

    /**
     * Get TTS audio for text
     */
    async getAudioForText(text: string): Promise<Buffer | null> {
        try {
            return await this.voiceService.synthesize(text);
        } catch (error) {
            console.error('TTS error:', error);
            return null;
        }
    }

    /**
     * Transcribe audio buffer (for direct webview mic capture)
     */
    async transcribeAudio(audioBuffer: Buffer, mimeType: string): Promise<string> {
        try {
            console.log('transcribeAudio called, buffer size:', audioBuffer.length, 'mimeType:', mimeType);
            const transcript = await this.voiceService.transcribe(audioBuffer, mimeType);
            return transcript;
        } catch (error) {
            console.error('Transcription error in transcribeAudio:', error);
            throw error;
        }
    }

    private serveVoiceCapturePage(res: http.ServerResponse): void {
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Claude Code Voice Input</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
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
            font-size: 24px;
            margin-bottom: 10px;
            color: #64ffda;
        }
        .subtitle {
            color: #8892b0;
            margin-bottom: 40px;
        }
        .mic-button {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            border: none;
            background: linear-gradient(145deg, #e94560, #c73e54);
            color: white;
            font-size: 48px;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 10px 30px rgba(233, 69, 96, 0.3);
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 30px;
        }
        .mic-button:hover {
            transform: scale(1.05);
            box-shadow: 0 15px 40px rgba(233, 69, 96, 0.4);
        }
        .mic-button.recording {
            animation: pulse 1.5s ease-in-out infinite;
            background: linear-gradient(145deg, #ff6b6b, #e94560);
        }
        .mic-button.processing {
            background: linear-gradient(145deg, #ffd93d, #f0c929);
            animation: none;
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); box-shadow: 0 10px 30px rgba(233, 69, 96, 0.3); }
            50% { transform: scale(1.1); box-shadow: 0 15px 50px rgba(233, 69, 96, 0.5); }
        }
        .status {
            font-size: 18px;
            color: #ccd6f6;
            margin-bottom: 20px;
            min-height: 30px;
        }
        .transcript {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 20px;
            min-height: 100px;
            text-align: left;
            margin-top: 20px;
        }
        .transcript-label {
            color: #64ffda;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 10px;
        }
        .transcript-text {
            color: #ccd6f6;
            line-height: 1.6;
        }
        .audio-visualizer {
            display: flex;
            justify-content: center;
            gap: 4px;
            height: 40px;
            margin-bottom: 20px;
        }
        .visualizer-bar {
            width: 6px;
            background: #64ffda;
            border-radius: 3px;
            transition: height 0.1s ease;
        }
        .error {
            color: #ff6b6b;
            background: rgba(255, 107, 107, 0.1);
            padding: 10px 20px;
            border-radius: 8px;
            margin-top: 20px;
        }
        .close-hint {
            color: #8892b0;
            font-size: 14px;
            margin-top: 30px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Claude Code Voice</h1>
        <p class="subtitle">Click the microphone to start speaking</p>

        <div class="audio-visualizer" id="visualizer">
            ${Array(20).fill(0).map(() => '<div class="visualizer-bar" style="height: 5px;"></div>').join('')}
        </div>

        <button class="mic-button" id="micButton">
            <span id="micIcon">🎤</span>
        </button>

        <div class="status" id="status">Ready</div>

        <div class="transcript" id="transcriptBox" style="display: none;">
            <div class="transcript-label">Transcript</div>
            <div class="transcript-text" id="transcriptText"></div>
        </div>

        <div class="error" id="error" style="display: none;"></div>

        <p class="close-hint">Press Space to start, Escape to cancel</p>
    </div>

    <script>
        let mediaRecorder;
        let audioChunks = [];
        let audioContext;
        let analyser;
        let isRecording = false;
        let silenceTimeout;
        const SILENCE_THRESHOLD = 10;
        const SILENCE_DURATION = 1500; // ms of silence before auto-stop

        const micButton = document.getElementById('micButton');
        const micIcon = document.getElementById('micIcon');
        const status = document.getElementById('status');
        const transcriptBox = document.getElementById('transcriptBox');
        const transcriptText = document.getElementById('transcriptText');
        const errorDiv = document.getElementById('error');
        const visualizer = document.getElementById('visualizer');
        const visualizerBars = visualizer.querySelectorAll('.visualizer-bar');

        async function startRecording() {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });

                // Set up audio visualizer and silence detection
                audioContext = new AudioContext();
                analyser = audioContext.createAnalyser();
                const source = audioContext.createMediaStreamSource(stream);
                source.connect(analyser);
                analyser.fftSize = 64;
                updateVisualizer();

                // Set up recorder
                const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                    ? 'audio/webm;codecs=opus'
                    : 'audio/webm';

                mediaRecorder = new MediaRecorder(stream, { mimeType });
                audioChunks = [];

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        audioChunks.push(event.data);
                    }
                };

                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: mimeType });
                    await sendAudioForTranscription(audioBlob, mimeType);

                    // Clean up
                    stream.getTracks().forEach(track => track.stop());
                    if (audioContext) {
                        audioContext.close();
                    }
                };

                mediaRecorder.start();
                isRecording = true;
                micButton.classList.add('recording');
                micIcon.textContent = '⏹';
                status.textContent = 'Listening... Click to stop';

            } catch (error) {
                showError('Microphone access denied. Please allow microphone access.');
            }
        }

        function stopRecording() {
            if (silenceTimeout) {
                clearTimeout(silenceTimeout);
            }
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
                isRecording = false;
                micButton.classList.remove('recording');
                micButton.classList.add('processing');
                micIcon.textContent = '⏳';
                status.textContent = 'Processing...';

                visualizerBars.forEach(bar => bar.style.height = '5px');
            }
        }

        function updateVisualizer() {
            if (!analyser || !isRecording) return;

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(dataArray);

            // Calculate average volume
            const avgVolume = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

            // Silence detection
            if (avgVolume < SILENCE_THRESHOLD) {
                if (!silenceTimeout) {
                    silenceTimeout = setTimeout(() => {
                        if (isRecording) {
                            status.textContent = 'Silence detected, stopping...';
                            stopRecording();
                        }
                    }, SILENCE_DURATION);
                }
            } else {
                if (silenceTimeout) {
                    clearTimeout(silenceTimeout);
                    silenceTimeout = null;
                }
            }

            visualizerBars.forEach((bar, i) => {
                const value = dataArray[i] || 0;
                const height = Math.max(5, (value / 255) * 40);
                bar.style.height = height + 'px';
            });

            requestAnimationFrame(updateVisualizer);
        }

        async function sendAudioForTranscription(audioBlob, mimeType) {
            try {
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64 = reader.result.split(',')[1];

                    const response = await fetch('/transcribe', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            audio: base64,
                            mimeType: mimeType
                        })
                    });

                    const result = await response.json();

                    if (result.success) {
                        transcriptText.textContent = result.text;
                        transcriptBox.style.display = 'block';
                        status.textContent = 'Sent to Claude Code!';
                        micButton.classList.remove('processing');
                        micIcon.textContent = '✓';

                        // Auto-close after delay
                        setTimeout(() => {
                            window.close();
                        }, 2000);
                    } else {
                        showError(result.error || 'Transcription failed');
                    }
                };
                reader.readAsDataURL(audioBlob);
            } catch (error) {
                showError('Failed to send audio: ' + error.message);
            }
        }

        function showError(message) {
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
            status.textContent = 'Error';
            micButton.classList.remove('recording', 'processing');
            micIcon.textContent = '🎤';
        }

        // Event listeners
        micButton.addEventListener('click', () => {
            if (isRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !isRecording) {
                e.preventDefault();
                startRecording();
            } else if (e.code === 'Escape') {
                if (isRecording) {
                    // Cancel without sending
                    if (mediaRecorder && mediaRecorder.state === 'recording') {
                        mediaRecorder.stop();
                    }
                    isRecording = false;
                    micButton.classList.remove('recording', 'processing');
                    micIcon.textContent = '🎤';
                    status.textContent = 'Cancelled';
                }
                window.close();
            }
        });
    </script>
</body>
</html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    }
}
