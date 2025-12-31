/**
 * StreamingTTSManager - Handles sentence-level TTS with streaming playback
 *
 * Features:
 * - Splits text into sentences for progressive TTS
 * - Parallel TTS generation (generate next while playing current)
 * - Audio queue with pause/stop/interrupt
 * - Supports both native playback and browser bridge
 * - Allows user to interrupt/take over mid-playback
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { VoiceService } from './voice-service';

// Try to load sound-play for native playback
let soundPlay: any = null;
try {
    soundPlay = require('sound-play');
} catch (err) {
    console.log('sound-play not available for StreamingTTSManager');
}

export interface TTSQueueItem {
    id: string;
    text: string;
    audioBuffer?: Buffer;
    status: 'pending' | 'generating' | 'ready' | 'playing' | 'completed' | 'cancelled';
}

export interface StreamingTTSOptions {
    /** Callback to send audio to browser voice bridge */
    onBrowserAudio?: (audioBase64: string, text: string, isLast: boolean) => void;
    /** Callback to send audio to webview */
    onWebviewAudio?: (audioBase64: string, mimeType: string) => void;
    /** Callback when playback state changes */
    onStateChange?: (state: PlaybackState) => void;
    /** Callback when a sentence starts playing */
    onSentenceStart?: (text: string, index: number, total: number) => void;
    /** Callback when all playback completes */
    onComplete?: () => void;
    /** Callback when interrupted by user */
    onInterrupt?: () => void;
}

export type PlaybackState = 'idle' | 'generating' | 'playing' | 'paused' | 'stopped';

export class StreamingTTSManager {
    private voiceService: VoiceService;
    private options: StreamingTTSOptions;
    private queue: TTSQueueItem[] = [];
    private state: PlaybackState = 'idle';
    private currentIndex: number = 0;
    private isPaused: boolean = false;
    private isStopped: boolean = false;
    private currentPlayPromise: Promise<void> | null = null;
    private generatePromises: Map<string, Promise<Buffer | null>> = new Map();

    constructor(voiceService: VoiceService, options: StreamingTTSOptions = {}) {
        this.voiceService = voiceService;
        this.options = options;
    }

    /**
     * Split text into sentences for progressive TTS
     */
    private splitIntoSentences(text: string): string[] {
        // Match sentences ending with . ! ? or newlines
        // Keep the punctuation with the sentence
        const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];

        // Filter out empty strings and trim
        return sentences
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }

    /**
     * Start streaming TTS for the given text
     * Returns immediately, plays audio progressively
     */
    async streamText(text: string): Promise<void> {
        // Stop any current playback
        await this.stop();

        // Reset state
        this.queue = [];
        this.currentIndex = 0;
        this.isPaused = false;
        this.isStopped = false;
        this.generatePromises.clear();

        // Split into sentences
        const sentences = this.splitIntoSentences(text);
        console.log(`StreamingTTS: Split into ${sentences.length} sentences`);

        if (sentences.length === 0) {
            return;
        }

        // Create queue items
        this.queue = sentences.map((sentence, index) => ({
            id: `tts-${Date.now()}-${index}`,
            text: sentence,
            status: 'pending' as const
        }));

        // Update state
        this.setState('generating');

        // Start generating TTS for first 2 sentences in parallel
        this.startGenerating(0);
        if (sentences.length > 1) {
            this.startGenerating(1);
        }

        // Start playback loop
        await this.playbackLoop();
    }

    /**
     * Start TTS generation for a queue item
     */
    private async startGenerating(index: number): Promise<void> {
        if (index >= this.queue.length) return;

        const item = this.queue[index];
        if (item.status !== 'pending') return;

        item.status = 'generating';
        console.log(`StreamingTTS: Generating audio for sentence ${index + 1}/${this.queue.length}`);

        const promise = this.voiceService.synthesize(item.text)
            .then(buffer => {
                if (!this.isStopped) {
                    item.audioBuffer = buffer;
                    item.status = 'ready';
                    console.log(`StreamingTTS: Sentence ${index + 1} ready`);
                }
                return buffer;
            })
            .catch(err => {
                console.error(`StreamingTTS: Error generating sentence ${index + 1}:`, err);
                item.status = 'cancelled';
                return null;
            });

        this.generatePromises.set(item.id, promise);
    }

    /**
     * Main playback loop
     */
    private async playbackLoop(): Promise<void> {
        while (this.currentIndex < this.queue.length && !this.isStopped) {
            // Wait if paused
            while (this.isPaused && !this.isStopped) {
                await this.sleep(100);
            }

            if (this.isStopped) break;

            const item = this.queue[this.currentIndex];

            // Wait for current item to be ready
            if (item.status === 'pending' || item.status === 'generating') {
                const promise = this.generatePromises.get(item.id);
                if (promise) {
                    await promise;
                } else {
                    // Not started yet, start it
                    this.startGenerating(this.currentIndex);
                    await this.generatePromises.get(item.id);
                }
            }

            if (this.isStopped || item.status === 'cancelled') break;

            // Start generating next sentence while playing current
            if (this.currentIndex + 1 < this.queue.length) {
                const nextItem = this.queue[this.currentIndex + 1];
                if (nextItem.status === 'pending') {
                    this.startGenerating(this.currentIndex + 1);
                }
            }

            // Also pre-generate the one after next
            if (this.currentIndex + 2 < this.queue.length) {
                const nextNextItem = this.queue[this.currentIndex + 2];
                if (nextNextItem.status === 'pending') {
                    this.startGenerating(this.currentIndex + 2);
                }
            }

            // Play current item
            if (item.audioBuffer && item.status === 'ready') {
                this.setState('playing');
                item.status = 'playing';

                // Notify listeners
                this.options.onSentenceStart?.(
                    item.text,
                    this.currentIndex,
                    this.queue.length
                );

                const isLast = this.currentIndex === this.queue.length - 1;

                // Send to browser bridge if callback provided
                if (this.options.onBrowserAudio) {
                    const base64 = item.audioBuffer.toString('base64');
                    this.options.onBrowserAudio(base64, item.text, isLast);
                }

                // Play natively if available
                if (soundPlay && !this.options.onBrowserAudio) {
                    await this.playNatively(item.audioBuffer);
                } else if (this.options.onWebviewAudio && !this.options.onBrowserAudio) {
                    // Send to webview if no browser bridge
                    const base64 = item.audioBuffer.toString('base64');
                    this.options.onWebviewAudio(base64, 'audio/mp3');
                }

                item.status = 'completed';
            }

            this.currentIndex++;
        }

        // All done
        this.setState('idle');
        if (!this.isStopped) {
            this.options.onComplete?.();
        }
    }

    /**
     * Play audio buffer natively using sound-play
     */
    private async playNatively(audioBuffer: Buffer): Promise<void> {
        if (!soundPlay) return;

        const tempFile = path.join(os.tmpdir(), `claude-tts-stream-${Date.now()}.mp3`);

        try {
            fs.writeFileSync(tempFile, audioBuffer);

            this.currentPlayPromise = soundPlay.play(tempFile);
            await this.currentPlayPromise;

        } catch (err) {
            console.error('Native playback error:', err);
        } finally {
            this.currentPlayPromise = null;
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }

    /**
     * Pause playback
     */
    pause(): void {
        if (this.state === 'playing') {
            this.isPaused = true;
            this.setState('paused');
        }
    }

    /**
     * Resume playback
     */
    resume(): void {
        if (this.state === 'paused') {
            this.isPaused = false;
            this.setState('playing');
        }
    }

    /**
     * Stop playback and clear queue
     */
    async stop(): Promise<void> {
        this.isStopped = true;
        this.isPaused = false;

        // Cancel all pending generations
        for (const item of this.queue) {
            if (item.status === 'pending' || item.status === 'generating') {
                item.status = 'cancelled';
            }
        }

        // Wait for current playback to finish (can't interrupt native playback easily)
        if (this.currentPlayPromise) {
            try {
                await this.currentPlayPromise;
            } catch (e) {
                // Ignore
            }
        }

        this.queue = [];
        this.currentIndex = 0;
        this.generatePromises.clear();
        this.setState('idle');
    }

    /**
     * Interrupt current playback (user wants to speak)
     */
    async interrupt(): Promise<void> {
        console.log('StreamingTTS: User interrupt requested');
        await this.stop();
        this.options.onInterrupt?.();
    }

    /**
     * Skip to next sentence
     */
    skipCurrent(): void {
        if (this.currentIndex < this.queue.length - 1) {
            const item = this.queue[this.currentIndex];
            item.status = 'cancelled';
            // The playback loop will move to next
        }
    }

    /**
     * Get current playback state
     */
    getState(): PlaybackState {
        return this.state;
    }

    /**
     * Get current queue status
     */
    getQueueStatus(): { current: number; total: number; state: PlaybackState } {
        return {
            current: this.currentIndex,
            total: this.queue.length,
            state: this.state
        };
    }

    /**
     * Check if currently playing or generating
     */
    isActive(): boolean {
        return this.state !== 'idle';
    }

    private setState(state: PlaybackState): void {
        this.state = state;
        this.options.onStateChange?.(state);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * MessageQueue - Allows queuing user messages while Claude is processing
 *
 * This enables multi-turn conversation without blocking:
 * - User can add messages while Claude is responding
 * - Messages are processed in order
 * - User can see their queued messages
 */
export interface QueuedMessage {
    id: string;
    text: string;
    timestamp: number;
    status: 'queued' | 'processing' | 'completed';
}

export class MessageQueue {
    private queue: QueuedMessage[] = [];
    private isProcessing: boolean = false;
    private processCallback: ((message: string) => Promise<void>) | null = null;
    private onQueueChange: ((queue: QueuedMessage[]) => void) | null = null;

    constructor(
        processCallback: (message: string) => Promise<void>,
        onQueueChange?: (queue: QueuedMessage[]) => void
    ) {
        this.processCallback = processCallback;
        this.onQueueChange = onQueueChange || null;
    }

    /**
     * Add a message to the queue
     */
    addMessage(text: string): QueuedMessage {
        const message: QueuedMessage = {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text,
            timestamp: Date.now(),
            status: 'queued'
        };

        this.queue.push(message);
        this.notifyQueueChange();

        // Start processing if not already
        if (!this.isProcessing) {
            this.processNext();
        }

        return message;
    }

    /**
     * Process next message in queue
     */
    private async processNext(): Promise<void> {
        if (this.isProcessing || this.queue.length === 0) return;

        const message = this.queue.find(m => m.status === 'queued');
        if (!message) return;

        this.isProcessing = true;
        message.status = 'processing';
        this.notifyQueueChange();

        try {
            if (this.processCallback) {
                await this.processCallback(message.text);
            }
            message.status = 'completed';
        } catch (err) {
            console.error('Message processing error:', err);
            message.status = 'completed'; // Mark as done even on error
        }

        this.isProcessing = false;
        this.notifyQueueChange();

        // Process next in queue
        setTimeout(() => this.processNext(), 100);
    }

    /**
     * Get all queued messages (not yet processing)
     */
    getQueuedMessages(): QueuedMessage[] {
        return this.queue.filter(m => m.status === 'queued');
    }

    /**
     * Get queue length
     */
    getQueueLength(): number {
        return this.queue.filter(m => m.status === 'queued').length;
    }

    /**
     * Check if currently processing
     */
    isCurrentlyProcessing(): boolean {
        return this.isProcessing;
    }

    /**
     * Clear all queued messages (not the one being processed)
     */
    clearQueue(): void {
        this.queue = this.queue.filter(m => m.status === 'processing');
        this.notifyQueueChange();
    }

    /**
     * Remove a specific queued message
     */
    removeMessage(id: string): boolean {
        const index = this.queue.findIndex(m => m.id === id && m.status === 'queued');
        if (index !== -1) {
            this.queue.splice(index, 1);
            this.notifyQueueChange();
            return true;
        }
        return false;
    }

    private notifyQueueChange(): void {
        if (this.onQueueChange) {
            this.onQueueChange([...this.queue]);
        }
    }
}
