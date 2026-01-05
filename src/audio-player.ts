/**
 * Native audio player using Audify (RtAudio bindings)
 * Plays audio directly in Node.js extension host with full controls
 *
 * Features:
 * - MP3 decoding via mpg123-decoder (WASM, no native build)
 * - Playback via Audify RtAudio (native, cross-platform)
 * - Full controls: play, pause, resume, stop, mute, volume
 * - Queue management with skip functionality
 * - Bypasses webview autoplay restrictions
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use require for native/WASM modules
let RtAudio: any;
let RtAudioFormat: any;
let isAudifyAvailable = false;
let MPGDecoder: any;
let isDecoderAvailable = false;

try {
    const audify = require('audify');
    RtAudio = audify.RtAudio;
    RtAudioFormat = audify.RtAudioFormat;
    isAudifyAvailable = true;
    console.log('AudioPlayer: Audify loaded successfully');
} catch (error) {
    console.log('AudioPlayer: Audify not available:', error);
}

// Load mpg123-decoder asynchronously
async function loadDecoder(): Promise<boolean> {
    if (isDecoderAvailable) return true;
    try {
        const mod = await import('mpg123-decoder');
        MPGDecoder = mod.MPEGDecoder;
        isDecoderAvailable = true;
        console.log('AudioPlayer: mpg123-decoder loaded successfully');
        return true;
    } catch (error) {
        console.log('AudioPlayer: mpg123-decoder not available:', error);
        return false;
    }
}

// Initialize decoder on module load
loadDecoder();

export interface AudioQueueItem {
    id: string;
    audioBuffer: Buffer;  // MP3 data
    pcmData?: Buffer;     // Decoded PCM data as Buffer
    sampleRate?: number;  // Sample rate from decoder
    channels?: number;    // Number of channels from decoder
    text?: string;
    status: 'pending' | 'decoding' | 'ready' | 'playing' | 'paused' | 'completed' | 'cancelled';
}

export interface AudioPlayerOptions {
    /** Initial volume 0-1 (default: 1.0) */
    volume?: number;
    /** Callback when playback state changes */
    onStateChange?: (state: PlaybackState, item?: AudioQueueItem) => void;
    /** Callback when queue changes */
    onQueueChange?: (queue: AudioQueueItem[]) => void;
    /** Callback when an item starts playing */
    onPlayStart?: (item: AudioQueueItem, index: number, total: number) => void;
    /** Callback when all playback completes */
    onComplete?: () => void;
}

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'stopped';

export class AudioPlayer {
    private rtAudio: any = null;
    private options: Required<AudioPlayerOptions>;
    private queue: AudioQueueItem[] = [];
    private currentIndex: number = 0;
    private state: PlaybackState = 'idle';
    private volume: number = 1.0;
    private isMuted: boolean = false;
    private isProcessingQueue: boolean = false;
    private streamOpen: boolean = false;
    private currentItem: AudioQueueItem | null = null;
    private pcmOffset: number = 0;
    private frameSize: number = 1024;
    private writeInterval: NodeJS.Timeout | null = null;
    private nativeSampleRate: number = 48000; // Will be auto-detected

    constructor(options: AudioPlayerOptions = {}) {
        this.options = {
            volume: options.volume ?? 1.0,
            onStateChange: options.onStateChange ?? (() => {}),
            onQueueChange: options.onQueueChange ?? (() => {}),
            onPlayStart: options.onPlayStart ?? (() => {}),
            onComplete: options.onComplete ?? (() => {})
        };
        this.volume = this.options.volume;

        // Auto-detect native sample rate from output device
        this.detectNativeSampleRate();
        console.log('AudioPlayer: Initialized with native sample rate:', this.nativeSampleRate);
    }

    /**
     * Detect the native sample rate from the default output device
     */
    private detectNativeSampleRate(): void {
        if (!isAudifyAvailable) return;

        try {
            const tempRtAudio = new RtAudio();
            const defaultOutput = tempRtAudio.getDefaultOutputDevice();
            const devices = tempRtAudio.getDevices();

            const outputDevice = devices.find((d: any) => d.id === defaultOutput);
            if (outputDevice && outputDevice.preferredSampleRate) {
                this.nativeSampleRate = outputDevice.preferredSampleRate;
                console.log('AudioPlayer: Detected native sample rate:', this.nativeSampleRate, 'from device:', outputDevice.name);
            } else if (outputDevice && outputDevice.sampleRates && outputDevice.sampleRates.length > 0) {
                // Use the highest supported sample rate
                this.nativeSampleRate = Math.max(...outputDevice.sampleRates);
                console.log('AudioPlayer: Using max supported sample rate:', this.nativeSampleRate);
            }
        } catch (error) {
            console.log('AudioPlayer: Could not detect native sample rate, using default:', this.nativeSampleRate);
        }
    }

    /**
     * Check if audio player is available
     */
    static isAvailable(): boolean {
        return isAudifyAvailable;
    }

    /**
     * Ensure decoder is loaded
     */
    async ensureDecoder(): Promise<boolean> {
        return await loadDecoder();
    }

    /**
     * Initialize the audio output stream
     */
    private initStream(sampleRate: number, channels: number): boolean {
        if (this.streamOpen) {
            // Close existing stream if sample rate/channels changed
            try {
                this.rtAudio.closeStream();
            } catch (e) {}
            this.streamOpen = false;
        }

        if (!isAudifyAvailable) {
            console.error('AudioPlayer: Audify not available');
            return false;
        }

        try {
            this.rtAudio = new RtAudio();

            // Get default output device
            const defaultOutput = this.rtAudio.getDefaultOutputDevice();
            console.log('AudioPlayer: Using output device:', defaultOutput, 'sampleRate:', sampleRate, 'channels:', channels);

            // Open output-only stream
            this.rtAudio.openStream(
                {
                    deviceId: defaultOutput,
                    nChannels: channels,
                    firstChannel: 0
                },
                null, // No input
                RtAudioFormat.RTAUDIO_SINT16, // 16-bit signed int
                sampleRate,
                this.frameSize, // Frame size
                "ClaudeCodeVoice", // Stream name
                null, // No input callback
                null  // No frame output callback
            );

            this.streamOpen = true;
            console.log('AudioPlayer: Stream opened successfully');
            return true;
        } catch (error) {
            console.error('AudioPlayer: Failed to init stream:', error);
            return false;
        }
    }

    /**
     * Simple linear interpolation resampling
     */
    private resampleChannel(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
        const ratio = inputRate / outputRate;
        const outputLength = Math.floor(input.length / ratio);
        const output = new Float32Array(outputLength);

        for (let i = 0; i < outputLength; i++) {
            const srcIndex = i * ratio;
            const srcIndexFloor = Math.floor(srcIndex);
            const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
            const fraction = srcIndex - srcIndexFloor;

            // Linear interpolation
            output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction;
        }

        return output;
    }

    /**
     * Decode MP3 buffer to PCM Buffer (Int16 interleaved)
     * Resamples to 48000Hz if needed for device compatibility
     */
    private async decodeMP3(mp3Buffer: Buffer): Promise<{ pcmData: Buffer; sampleRate: number; channels: number }> {
        if (!isDecoderAvailable || !MPGDecoder) {
            // Try loading again
            await loadDecoder();
            if (!isDecoderAvailable || !MPGDecoder) {
                throw new Error('MP3 decoder not available');
            }
        }

        // Create decoder instance
        const decoder = new MPGDecoder();
        await decoder.ready;

        // Decode the MP3 data
        const result = await decoder.decode(new Uint8Array(mp3Buffer));

        // Get audio properties
        let sampleRate = result.sampleRate || 44100;
        const numChannels = result.channelData.length;

        // Free decoder resources
        decoder.free();

        // Get channel data
        let leftChannel = result.channelData[0];
        let rightChannel = numChannels > 1 ? result.channelData[1] : leftChannel;

        // Resample to native sample rate if needed (e.g., macOS doesn't support 24000Hz)
        if (sampleRate !== this.nativeSampleRate) {
            console.log(`AudioPlayer: Resampling from ${sampleRate}Hz to ${this.nativeSampleRate}Hz`);
            leftChannel = this.resampleChannel(leftChannel, sampleRate, this.nativeSampleRate);
            rightChannel = numChannels > 1
                ? this.resampleChannel(rightChannel, sampleRate, this.nativeSampleRate)
                : leftChannel;
            sampleRate = this.nativeSampleRate;
        }

        const numSamples = leftChannel.length;

        // Create Int16 buffer (2 bytes per sample, interleaved stereo)
        const pcmBuffer = Buffer.alloc(numSamples * numChannels * 2);

        for (let i = 0; i < numSamples; i++) {
            // Convert float (-1 to 1) to int16 (-32768 to 32767)
            const leftSample = Math.max(-32768, Math.min(32767, Math.floor(leftChannel[i] * 32767)));
            const rightSample = Math.max(-32768, Math.min(32767, Math.floor(rightChannel[i] * 32767)));

            // Write interleaved samples (little-endian)
            pcmBuffer.writeInt16LE(leftSample, i * numChannels * 2);
            if (numChannels > 1) {
                pcmBuffer.writeInt16LE(rightSample, i * numChannels * 2 + 2);
            }
        }

        console.log(`AudioPlayer: Decoded ${mp3Buffer.length} bytes MP3 to ${pcmBuffer.length} bytes PCM @ ${sampleRate}Hz, ${numChannels}ch`);
        return { pcmData: pcmBuffer, sampleRate, channels: numChannels };
    }

    /**
     * Add audio to the queue
     */
    async addToQueue(mp3Buffer: Buffer, text?: string): Promise<AudioQueueItem> {
        const item: AudioQueueItem = {
            id: `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            audioBuffer: mp3Buffer,
            text: text,
            status: 'pending'
        };

        this.queue.push(item);
        console.log('AudioPlayer: Added to queue, length:', this.queue.length);
        this.options.onQueueChange(this.queue);

        // Start processing if not already
        if (!this.isProcessingQueue) {
            this.processQueue();
        }

        return item;
    }

    /**
     * Process the audio queue
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue) return;

        // Find next pending item
        const nextItem = this.queue.find(item => item.status === 'pending');
        if (!nextItem) {
            this.isProcessingQueue = false;
            if (this.queue.every(item => item.status === 'completed' || item.status === 'cancelled')) {
                this.setState('idle');
                this.options.onComplete();
            }
            return;
        }

        this.isProcessingQueue = true;
        this.currentIndex = this.queue.indexOf(nextItem);

        try {
            // Decode MP3 to PCM
            nextItem.status = 'decoding';
            this.options.onQueueChange(this.queue);

            const { pcmData, sampleRate, channels } = await this.decodeMP3(nextItem.audioBuffer);
            nextItem.pcmData = pcmData;
            nextItem.sampleRate = sampleRate;
            nextItem.channels = channels;
            nextItem.status = 'ready';

            // Initialize stream with correct sample rate/channels
            if (!this.initStream(sampleRate, channels)) {
                throw new Error('Failed to initialize audio stream');
            }

            // Play the audio
            await this.playItem(nextItem);

        } catch (error) {
            console.error('AudioPlayer: Error processing queue item:', error);
            nextItem.status = 'completed';
        }

        this.isProcessingQueue = false;
        this.options.onQueueChange(this.queue);

        // Process next item
        this.processQueue();
    }

    /**
     * Play a single queue item
     */
    private async playItem(item: AudioQueueItem): Promise<void> {
        if (!item.pcmData || !this.rtAudio || !this.streamOpen) {
            item.status = 'completed';
            return;
        }

        this.currentItem = item;
        this.pcmOffset = 0;
        item.status = 'playing';
        this.setState('playing');

        // Notify listeners
        this.options.onPlayStart(item, this.currentIndex, this.queue.length);
        this.options.onQueueChange(this.queue);

        // Start the RtAudio stream
        this.rtAudio.start();

        // Calculate bytes per frame (frameSize samples × channels × 2 bytes per sample)
        const channels = item.channels || 2;
        const bytesPerFrame = this.frameSize * channels * 2;

        return new Promise<void>((resolve) => {
            // Write PCM data in chunks using interval
            this.writeInterval = setInterval(() => {
                if (!this.currentItem || this.currentItem.id !== item.id) {
                    // Item changed, stop this interval
                    if (this.writeInterval) {
                        clearInterval(this.writeInterval);
                        this.writeInterval = null;
                    }
                    resolve();
                    return;
                }

                if (this.state === 'stopped' || item.status === 'cancelled') {
                    if (this.writeInterval) {
                        clearInterval(this.writeInterval);
                        this.writeInterval = null;
                    }
                    item.status = 'completed';
                    resolve();
                    return;
                }

                if (this.state === 'paused') {
                    // Don't write while paused, but keep interval running
                    return;
                }

                if (this.pcmOffset >= item.pcmData!.length) {
                    // Playback complete
                    if (this.writeInterval) {
                        clearInterval(this.writeInterval);
                        this.writeInterval = null;
                    }
                    item.status = 'completed';
                    this.currentItem = null;

                    // Stop the stream
                    try {
                        this.rtAudio.stop();
                    } catch (e) {}

                    resolve();
                    return;
                }

                // Get next chunk - MUST be exactly bytesPerFrame
                const remaining = item.pcmData!.length - this.pcmOffset;
                let chunk: Buffer;

                if (remaining >= bytesPerFrame) {
                    chunk = Buffer.from(item.pcmData!.subarray(this.pcmOffset, this.pcmOffset + bytesPerFrame));
                    this.pcmOffset += bytesPerFrame;
                } else if (remaining > 0) {
                    // Pad last chunk with silence to make it exactly bytesPerFrame
                    chunk = Buffer.alloc(bytesPerFrame);
                    item.pcmData!.copy(chunk, 0, this.pcmOffset, this.pcmOffset + remaining);
                    this.pcmOffset = item.pcmData!.length; // Mark as complete after this
                } else {
                    return; // No more data
                }

                // Apply volume/mute
                if (this.isMuted || this.volume === 0) {
                    // Write silence
                    chunk = Buffer.alloc(bytesPerFrame);
                } else if (this.volume !== 1.0) {
                    // Apply volume - create new buffer with adjusted samples
                    for (let i = 0; i < chunk.length; i += 2) {
                        const sample = chunk.readInt16LE(i);
                        const adjustedSample = Math.floor(sample * this.volume);
                        chunk.writeInt16LE(Math.max(-32768, Math.min(32767, adjustedSample)), i);
                    }
                }

                // Write to RtAudio
                try {
                    this.rtAudio.write(chunk);
                } catch (e) {
                    console.error('AudioPlayer: Write error:', e);
                }
            }, 10); // Write every 10ms for smooth playback
        });
    }

    /**
     * Pause playback
     */
    pause(): void {
        if (this.state === 'playing') {
            this.setState('paused');
            if (this.currentItem) {
                this.currentItem.status = 'paused';
                this.options.onQueueChange(this.queue);
            }
        }
    }

    /**
     * Resume playback
     */
    resume(): void {
        if (this.state === 'paused') {
            this.setState('playing');
            if (this.currentItem) {
                this.currentItem.status = 'playing';
                this.options.onQueueChange(this.queue);
            }
        }
    }

    /**
     * Stop all playback and clear queue
     */
    stop(): void {
        this.setState('stopped');

        // Stop write interval
        if (this.writeInterval) {
            clearInterval(this.writeInterval);
            this.writeInterval = null;
        }

        // Stop the stream
        if (this.rtAudio && this.streamOpen) {
            try {
                this.rtAudio.stop();
            } catch (e) {}
        }

        // Mark all items as cancelled
        for (const item of this.queue) {
            if (item.status !== 'completed') {
                item.status = 'cancelled';
            }
        }

        this.queue = [];
        this.currentItem = null;
        this.pcmOffset = 0;
        this.isProcessingQueue = false;
        this.options.onQueueChange(this.queue);
    }

    /**
     * Skip current item and play next
     */
    skip(): void {
        if (this.currentItem) {
            this.currentItem.status = 'cancelled';

            // Stop write interval
            if (this.writeInterval) {
                clearInterval(this.writeInterval);
                this.writeInterval = null;
            }

            // Stop stream
            if (this.rtAudio && this.streamOpen) {
                try {
                    this.rtAudio.stop();
                } catch (e) {}
            }

            this.currentItem = null;
            this.pcmOffset = 0;
            this.options.onQueueChange(this.queue);
        }
    }

    /**
     * Set mute state
     */
    setMuted(muted: boolean): void {
        this.isMuted = muted;
        console.log('AudioPlayer: Mute set to:', muted);
    }

    /**
     * Toggle mute
     */
    toggleMute(): boolean {
        this.isMuted = !this.isMuted;
        console.log('AudioPlayer: Mute toggled to:', this.isMuted);
        return this.isMuted;
    }

    /**
     * Get mute state
     */
    getMuted(): boolean {
        return this.isMuted;
    }

    /**
     * Set volume (0-1)
     */
    setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume));
        console.log('AudioPlayer: Volume set to:', this.volume);
    }

    /**
     * Get volume
     */
    getVolume(): number {
        return this.volume;
    }

    /**
     * Get current playback state
     */
    getState(): PlaybackState {
        return this.state;
    }

    /**
     * Get queue status
     */
    getQueueStatus(): { current: number; total: number; state: PlaybackState } {
        return {
            current: this.currentIndex,
            total: this.queue.length,
            state: this.state
        };
    }

    /**
     * Check if currently playing or has items in queue
     */
    isActive(): boolean {
        return this.state !== 'idle' || this.queue.length > 0;
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        this.stop();
        if (this.rtAudio && this.streamOpen) {
            try {
                this.rtAudio.closeStream();
            } catch (e) {}
        }
        this.streamOpen = false;
        this.rtAudio = null;
    }

    private setState(state: PlaybackState): void {
        this.state = state;
        this.options.onStateChange(state, this.currentItem || undefined);
    }
}

// Export singleton instance for easy access
let audioPlayerInstance: AudioPlayer | null = null;

export function getAudioPlayer(options?: AudioPlayerOptions): AudioPlayer {
    if (!audioPlayerInstance) {
        audioPlayerInstance = new AudioPlayer(options);
    }
    return audioPlayerInstance;
}

export function disposeAudioPlayer(): void {
    if (audioPlayerInstance) {
        audioPlayerInstance.dispose();
        audioPlayerInstance = null;
    }
}
