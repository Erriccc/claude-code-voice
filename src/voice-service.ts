import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export class VoiceService {
    private getConfig() {
        return vscode.workspace.getConfiguration('claudeCodeChat');
    }

    /**
     * Transcribe audio to text using Whisper API (OpenAI or local)
     */
    async transcribe(audioBuffer: Buffer, mimeType: string = 'audio/webm'): Promise<string> {
        const config = this.getConfig();
        const provider = config.get<string>('voice.sttProvider', 'openai');

        let baseUrl: string;
        let apiKey: string | undefined;

        if (provider === 'local-whisper') {
            baseUrl = config.get<string>('voice.localWhisperUrl', 'http://127.0.0.1:2022/v1');
        } else {
            baseUrl = 'https://api.openai.com/v1';
            apiKey = config.get<string>('voice.openaiApiKey');
            if (!apiKey) {
                throw new Error('OpenAI API key not configured. Set claudeCodeChat.voice.openaiApiKey in settings.');
            }
        }

        const url = new URL(`${baseUrl}/audio/transcriptions`);
        const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);

        // Build multipart form data
        const parts: Buffer[] = [];

        // Add file part
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
        ));
        parts.push(audioBuffer);
        parts.push(Buffer.from('\r\n'));

        // Add model part
        parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="model"\r\n\r\n` +
            `whisper-1\r\n`
        ));

        // End boundary
        parts.push(Buffer.from(`--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        return new Promise((resolve, reject) => {
            const protocol = url.protocol === 'https:' ? https : http;

            const req = protocol.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length,
                    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`STT API error: ${res.statusCode} - ${data}`));
                        return;
                    }
                    try {
                        const result = JSON.parse(data);
                        resolve(result.text || '');
                    } catch (e) {
                        reject(new Error(`Failed to parse STT response: ${data}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /**
     * Convert text to speech using TTS API (OpenAI or local Kokoro)
     */
    async synthesize(text: string): Promise<Buffer> {
        const config = this.getConfig();
        const provider = config.get<string>('voice.ttsProvider', 'openai');
        const voice = config.get<string>('voice.ttsVoice', 'alloy');

        let baseUrl: string;
        let apiKey: string | undefined;

        if (provider === 'local-kokoro') {
            baseUrl = config.get<string>('voice.localKokoroUrl', 'http://127.0.0.1:8880/v1');
        } else {
            baseUrl = 'https://api.openai.com/v1';
            apiKey = config.get<string>('voice.openaiApiKey');
            if (!apiKey) {
                throw new Error('OpenAI API key not configured.');
            }
        }

        const url = new URL(`${baseUrl}/audio/speech`);
        const body = JSON.stringify({
            model: 'tts-1',
            input: text,
            voice: voice,
            response_format: 'mp3'
        });

        return new Promise((resolve, reject) => {
            const protocol = url.protocol === 'https:' ? https : http;

            const req = protocol.request(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
                }
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`TTS API error: ${res.statusCode}`));
                        return;
                    }
                    resolve(Buffer.concat(chunks));
                });
            });

            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    /**
     * Check if local Whisper service is available
     */
    async checkWhisperAvailable(): Promise<boolean> {
        const config = this.getConfig();
        const baseUrl = config.get<string>('voice.localWhisperUrl', 'http://127.0.0.1:2022/v1');

        try {
            const url = new URL(`${baseUrl}/models`);
            return new Promise((resolve) => {
                const protocol = url.protocol === 'https:' ? https : http;
                const req = protocol.get(url, { timeout: 2000 }, (res) => {
                    resolve(res.statusCode === 200);
                });
                req.on('error', () => resolve(false));
                req.on('timeout', () => {
                    req.destroy();
                    resolve(false);
                });
            });
        } catch {
            return false;
        }
    }

    /**
     * Check if local Kokoro service is available
     */
    async checkKokoroAvailable(): Promise<boolean> {
        const config = this.getConfig();
        const baseUrl = config.get<string>('voice.localKokoroUrl', 'http://127.0.0.1:8880/v1');

        try {
            const url = new URL(`${baseUrl}/models`);
            return new Promise((resolve) => {
                const protocol = url.protocol === 'https:' ? https : http;
                const req = protocol.get(url, { timeout: 2000 }, (res) => {
                    resolve(res.statusCode === 200);
                });
                req.on('error', () => resolve(false));
                req.on('timeout', () => {
                    req.destroy();
                    resolve(false);
                });
            });
        } catch {
            return false;
        }
    }
}
