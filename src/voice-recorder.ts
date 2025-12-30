/**
 * Native voice recorder using Audify (RtAudio bindings)
 * Records audio directly in Node.js extension host
 *
 * Features:
 * - NO external dependencies (no sox, ffmpeg, arecord)
 * - Prebuilt binaries for N-API 5+ (most Node/Electron versions)
 * - Cross-platform: Windows, macOS, Linux
 * - Uses RtAudio C++ library (bundled)
 */

import * as vscode from 'vscode';

// Use require for audify (native module)
let RtAudio: any;
let RtAudioFormat: any;
let isAvailable = false;

try {
    const audify = require('audify');
    RtAudio = audify.RtAudio;
    RtAudioFormat = audify.RtAudioFormat;
    isAvailable = true;
    console.log('Audify loaded successfully');
} catch (error) {
    console.log('Audify not available:', error);
    isAvailable = false;
}

export interface VoiceRecorderOptions {
    /** Sample rate (default: 16000 - optimal for Whisper) */
    sampleRate?: number;
    /** Number of channels (default: 1 - mono) */
    channels?: number;
    /** Silence threshold (0-32767, default: 500) */
    silenceThreshold?: number;
    /** Duration of silence before auto-stop in ms (default: 1500) */
    silenceDuration?: number;
    /** Enable debug logging */
    debug?: boolean;
}

export interface RecordingResult {
    /** Audio data as WAV buffer */
    audioBuffer: Buffer;
    /** MIME type of the audio */
    mimeType: string;
    /** Duration in seconds (approximate) */
    duration: number;
}

export class VoiceRecorder {
    private rtAudio: any;
    private isRecording: boolean = false;
    private audioChunks: Buffer[] = [];
    private options: Required<VoiceRecorderOptions>;
    private recordingStartTime: number = 0;
    private silenceStartTime: number = 0;
    private actualSampleRate: number = 48000; // Will be set to device's preferred rate
    private statusBarItem: vscode.StatusBarItem;
    private resolveRecording?: (result: RecordingResult) => void;
    private rejectRecording?: (error: Error) => void;

    constructor(options: VoiceRecorderOptions = {}) {
        this.options = {
            sampleRate: options.sampleRate ?? 16000,
            channels: options.channels ?? 1,
            silenceThreshold: options.silenceThreshold ?? 500,
            silenceDuration: options.silenceDuration ?? 1500,
            debug: options.debug ?? false
        };

        // Create status bar item to show recording state
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
    }

    /**
     * Check if native recording is available
     */
    async isAvailable(): Promise<boolean> {
        console.log('VoiceRecorder.isAvailable() called, module loaded:', isAvailable);
        if (!isAvailable) {
            console.log('Audify module not loaded');
            return false;
        }
        try {
            // Try to create RtAudio instance - if this works, the native module loaded
            console.log('Creating RtAudio instance...');
            const testRtAudio = new RtAudio();
            console.log('Getting devices...');
            const devices = testRtAudio.getDevices();
            console.log('Found', devices.length, 'audio devices');
            const hasInputDevice = devices.some((d: any) => d.inputChannels > 0);
            console.log('Has input device:', hasInputDevice);
            if (this.options.debug) {
                console.log('Audio devices:', devices);
            }
            return hasInputDevice;
        } catch (error) {
            console.error('Native recording check failed:', error);
            return false;
        }
    }

    /**
     * Get list of available input devices
     */
    getInputDevices(): { id: number; name: string; channels: number }[] {
        if (!isAvailable) return [];
        try {
            const rtAudio = new RtAudio();
            const devices = rtAudio.getDevices();
            return devices
                .filter((d: any) => d.inputChannels > 0)
                .map((d: any) => ({
                    id: d.id,  // Use actual device ID, not array index
                    name: d.name,
                    channels: d.inputChannels
                }));
        } catch (error) {
            console.error('Error getting input devices:', error);
            return [];
        }
    }

    /**
     * Start recording audio
     * Returns a promise that resolves when recording stops (via silence detection or manual stop)
     */
    async startRecording(): Promise<RecordingResult> {
        if (!isAvailable) {
            throw new Error('Native recording not available');
        }
        if (this.isRecording) {
            throw new Error('Already recording');
        }

        return new Promise((resolve, reject) => {
            try {
                this.resolveRecording = resolve;
                this.rejectRecording = reject;
                this.audioChunks = [];
                this.recordingStartTime = Date.now();
                this.silenceStartTime = 0;

                // Create RtAudio instance
                this.rtAudio = new RtAudio();

                // Get default input device and its info
                const defaultInput = this.rtAudio.getDefaultInputDevice();
                const devices = this.rtAudio.getDevices();
                const deviceInfo = devices.find((d: any) => d.id === defaultInput);

                // Use device's preferred sample rate (macOS mics don't support 16kHz)
                const actualSampleRate = deviceInfo?.preferredSampleRate || 48000;
                console.log('Using input device:', defaultInput, 'sample rate:', actualSampleRate);

                // Store actual sample rate for WAV header
                this.actualSampleRate = actualSampleRate;

                // Frame size (samples per callback) - ~30ms worth of audio
                const frameSize = Math.floor(actualSampleRate * 0.03);

                // Open input stream
                this.rtAudio.openStream(
                    null, // No output
                    {
                        deviceId: defaultInput,
                        nChannels: this.options.channels,
                        firstChannel: 0
                    },
                    RtAudioFormat.RTAUDIO_SINT16, // 16-bit signed integer
                    actualSampleRate,
                    frameSize,
                    "VoiceRecorder",
                    (pcm: Buffer) => this.handleAudioData(pcm),
                    null // No flags
                );

                // Start the stream
                this.rtAudio.start();
                this.isRecording = true;
                this.showRecordingStatus();

                console.log('Native recording started with Audify');

            } catch (error) {
                this.isRecording = false;
                this.hideRecordingStatus();
                reject(error);
            }
        });
    }

    /**
     * Handle incoming audio data
     */
    private handleAudioData(pcm: Buffer): void {
        if (!this.isRecording) return;

        this.audioChunks.push(Buffer.from(pcm));

        // Check for silence (voice activity detection)
        const maxAmplitude = this.getMaxAmplitude(pcm);

        if (maxAmplitude < this.options.silenceThreshold) {
            // Silence detected
            if (this.silenceStartTime === 0) {
                this.silenceStartTime = Date.now();
            } else if (Date.now() - this.silenceStartTime > this.options.silenceDuration) {
                // Silence exceeded threshold, stop recording
                console.log('Silence detected, auto-stopping...');
                this.stopRecording();
            }
        } else {
            // Sound detected, reset silence timer
            this.silenceStartTime = 0;
        }

        if (this.options.debug) {
            console.log('Audio chunk:', pcm.length, 'bytes, max amplitude:', maxAmplitude);
        }
    }

    /**
     * Get maximum amplitude from audio buffer (16-bit samples)
     */
    private getMaxAmplitude(buffer: Buffer): number {
        let max = 0;
        for (let i = 0; i < buffer.length; i += 2) {
            const sample = Math.abs(buffer.readInt16LE(i));
            if (sample > max) max = sample;
        }
        return max;
    }

    /**
     * Stop recording and return the result
     */
    stopRecording(): void {
        if (!this.isRecording) return;

        console.log('Stopping recording...');
        this.isRecording = false;

        try {
            if (this.rtAudio) {
                this.rtAudio.stop();
                this.rtAudio.closeStream();
            }
        } catch (e) {
            console.error('Error stopping audio stream:', e);
        }

        this.hideRecordingStatus();

        const duration = (Date.now() - this.recordingStartTime) / 1000;

        if (this.audioChunks.length === 0) {
            if (this.rejectRecording) {
                this.rejectRecording(new Error('No audio recorded'));
            }
            return;
        }

        // Combine chunks into raw PCM data
        const rawPcm = Buffer.concat(this.audioChunks);
        console.log('Raw PCM size:', rawPcm.length, 'bytes, duration:', duration.toFixed(1), 's');

        // Convert to WAV format (Whisper accepts WAV)
        const wavBuffer = this.createWavBuffer(rawPcm);

        if (this.resolveRecording) {
            this.resolveRecording({
                audioBuffer: wavBuffer,
                mimeType: 'audio/wav',
                duration
            });
        }

        this.cleanup();
    }

    /**
     * Create a WAV buffer from raw PCM data
     */
    private createWavBuffer(pcmData: Buffer): Buffer {
        const sampleRate = this.actualSampleRate; // Use actual device sample rate
        const channels = this.options.channels;
        const bitsPerSample = 16;
        const byteRate = sampleRate * channels * (bitsPerSample / 8);
        const blockAlign = channels * (bitsPerSample / 8);

        // WAV header is 44 bytes
        const header = Buffer.alloc(44);

        // RIFF chunk descriptor
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + pcmData.length, 4);
        header.write('WAVE', 8);

        // fmt sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitsPerSample, 34);

        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(pcmData.length, 40);

        return Buffer.concat([header, pcmData]);
    }

    /**
     * Check if currently recording
     */
    isCurrentlyRecording(): boolean {
        return this.isRecording;
    }

    private showRecordingStatus(): void {
        this.statusBarItem.text = '$(mic-filled) Recording...';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.statusBarItem.command = 'claude-code-chat.stopVoice';
        this.statusBarItem.tooltip = 'Click to stop recording';
        this.statusBarItem.show();

        vscode.window.setStatusBarMessage('$(mic-filled) Recording voice input... Speak now!', 10000);
    }

    private hideRecordingStatus(): void {
        this.statusBarItem.hide();
    }

    private cleanup(): void {
        this.resolveRecording = undefined;
        this.rejectRecording = undefined;
        this.rtAudio = undefined;
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        if (this.isRecording) {
            this.stopRecording();
        }
        this.statusBarItem.dispose();
    }
}
