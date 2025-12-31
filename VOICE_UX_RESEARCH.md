# Claude Code Voice - UX & Architecture Research

## Executive Summary

This document contains research findings and implementation plan for improving voice UX, performance, and multi-agent capabilities in the Claude Code Voice extension.

---

## 1. PERFORMANCE ANALYSIS

### Current Bottlenecks Identified

#### Transcription (STT)
- **Model**: `whisper-1` (OpenAI) - This is the standard model, already optimized
- **Latency Sources**:
  1. Network round-trip to OpenAI (~200-500ms)
  2. Audio encoding/decoding
  3. File size (larger audio = slower)
- **Typical latency**: 1-3 seconds for short audio clips

#### Text-to-Speech (TTS)
- **Model**: `tts-1` (OpenAI) - Already using the faster model (not `tts-1-hd`)
- **Latency Sources**:
  1. Wait for full audio buffer before playing (MAIN ISSUE)
  2. Network round-trip (~300-800ms for short text)
  3. Base64 encoding for browser transmission
- **Typical latency**: 1-4 seconds depending on text length

### Why the Lag Between Message Appearing and Audio Playing

**Current Flow (Sequential)**:
```
1. Claude response complete → speakResponse() called
2. Full text sent to OpenAI TTS API
3. Wait for entire audio buffer to return
4. Base64 encode the buffer
5. Send to browser via SSE
6. Browser decodes and plays
```

**Problem**: Steps 2-4 are blocking - audio doesn't start until ALL audio is generated.

### Recommended Performance Improvements

#### Quick Wins (No Architecture Change)
1. **Sentence-level TTS chunking**: Split response into sentences, generate TTS for first sentence immediately
2. **Parallel processing**: Start TTS for sentence 1 while Claude is still generating response
3. **Reduce audio quality for speed**: Use `speed` parameter in TTS API (1.0-4.0)

#### Implementation: Streaming TTS
```typescript
async speakResponseStreaming(text: string): Promise<void> {
    // Split into sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    // Process first sentence immediately
    const firstAudio = await this.voiceService.synthesize(sentences[0]);
    this.sendTTSToVoiceBridge(firstAudio, sentences[0]);

    // Queue remaining sentences
    for (let i = 1; i < sentences.length; i++) {
        const audio = await this.voiceService.synthesize(sentences[i]);
        // Send with small delay to allow previous to start playing
        this.sendTTSToVoiceBridge(audio, sentences[i]);
    }
}
```

---

## 2. BROWSER MODE UX IMPROVEMENTS

### Current Pain Points
- Must switch between browser tab and VS Code
- No continuous listening - must click each time
- No playback controls (pause, stop, mute)
- No visual feedback while waiting

### Recommended Solutions

#### A. Continuous Listening with Wake Word

**Option 1: Porcupine + VAD (RECOMMENDED for Production)**
- Use `@picovoice/porcupine-web` for wake word detection
- Use `@ricky0123/vad-web` for Voice Activity Detection
- Custom "Hey Claude" wake word (requires Picovoice account)
- Cost: ~$25-100/month for production

**Option 2: Push-to-Talk + VAD (FREE, Reliable)**
- Spacebar hold-to-talk on desktop
- Touch-and-hold button on mobile
- VAD for visual feedback ("listening..." indicator)
- Works on all platforms including iPad

**Recommended Implementation (Phase 1 - Push-to-Talk + VAD)**:
```javascript
// In browser voice page
let isListening = false;
let vad = null;

async function initVAD() {
    const { MicVAD } = await import('@ricky0123/vad-web');
    vad = await MicVAD.new({
        onSpeechStart: () => showSpeakingIndicator(),
        onSpeechEnd: (audio) => processSpeech(audio)
    });
}

// Keyboard shortcut (spacebar)
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isInputFocused()) {
        e.preventDefault();
        startRecording();
    }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        stopRecording();
    }
});
```

#### B. Enhanced Browser UI Controls

**Proposed UI Elements**:
```
┌─────────────────────────────────────────┐
│     Claude Code Voice Bridge            │
├─────────────────────────────────────────┤
│  [Connected to VS Code]                 │
│                                         │
│        ┌─────────────┐                  │
│        │     🎤      │  ← Main mic btn  │
│        │  [SPACE]    │                  │
│        └─────────────┘                  │
│                                         │
│  ┌──────┐ ┌──────┐ ┌──────┐            │
│  │ ⏸️   │ │ 🔇   │ │ 🔊   │ ← Controls │
│  │Pause │ │ Mute │ │Volume│            │
│  └──────┘ └──────┘ └──────┘            │
│                                         │
│  [Auto-listen: OFF] [Wake word: OFF]   │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ Chat History                     │   │
│  │ You: "What files are here?"     │   │
│  │ Claude: "I see 5 files..."      │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Control Features**:
1. **Pause/Resume**: Pause TTS playback
2. **Mute**: Mute audio output (still process, just silent)
3. **Volume**: Adjust playback volume
4. **Auto-listen**: After Claude speaks, auto-record next input
5. **Keyboard shortcuts**: Space = record, Esc = cancel, M = mute

---

## 3. CLAUDE-CODE-CHAT EXTENSION ARCHITECTURE (Your Extension)

### Current Internal Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   ClaudeChatProvider (Single Instance)          │
├─────────────────────────────────────────────────────────────────┤
│  State Management:                                               │
│  • _currentSessionId: string    - Active Claude CLI session     │
│  • _currentConversation: []     - Message history array         │
│  • _currentClaudeProcess        - Child process reference       │
│  • _totalCost, _totalTokens     - Usage tracking                │
│  • _isProcessing: boolean       - Request state                 │
│                                                                  │
│  Voice Integration:                                              │
│  • _voiceService: VoiceService  - OpenAI STT/TTS client        │
│  • _voiceRecorder: VoiceRecorder - Native Audify mic            │
│  • _voiceBridge: VoiceBridgeServer - Browser voice mode        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Communication with Claude CLI                       │
├─────────────────────────────────────────────────────────────────┤
│  Process Spawning:                                               │
│  • cp.spawn('claude', ['--output-format', 'stream-json', ...])  │
│  • Bidirectional JSON streaming via stdin/stdout                │
│  • Session resume: --resume SESSION_ID                          │
│                                                                  │
│  Message Types (stream-json):                                    │
│  • user → Claude: { type: 'user', message: {...} }              │
│  • Claude → ext: { type: 'content_block_delta', ... }           │
│  • Claude → ext: { type: 'result', session_id: 'xxx' }          │
│  • Claude → ext: { type: 'control_request', ... } (permissions) │
└─────────────────────────────────────────────────────────────────┘
```

### Session Flow

```
1. User sends message
   ↓
2. _sendMessageToClaude(message)
   ↓
3. Spawn claude CLI with --resume SESSION_ID (if exists)
   ↓
4. Write JSON to stdin: { type: 'user', message: {...} }
   ↓
5. Stream JSON responses from stdout
   ↓
6. Parse and display in webview
   ↓
7. On 'result' message → extract session_id → save for next resume
   ↓
8. Save conversation to local storage
```

### Conversation Storage (Local to Extension)

```
[workspaceStorage]/
└── conversations/
    └── YYYY-MM-DD_HHmmss_[sessionId].json

ConversationData:
{
  sessionId: string,
  startTime: string,
  endTime: string,
  messageCount: number,
  totalCost: number,
  totalTokens: { input, output },
  messages: Array<{ timestamp, messageType, data }>
}
```

### Current Limitations for Multi-Agent

1. **Single session**: Only `_currentSessionId` - can't track multiple
2. **Single process**: One `_currentClaudeProcess` at a time
3. **Single webview**: One `ClaudeChatProvider` instance
4. **No agent naming**: Sessions identified by UUID only

### Required Changes for Multi-Agent

```typescript
// Current (single agent)
private _currentSessionId: string | undefined;
private _currentClaudeProcess: cp.ChildProcess | undefined;

// Required (multi-agent)
private _agents: Map<string, {
    id: string;
    name: string;
    sessionId: string;
    process: cp.ChildProcess | undefined;
    conversation: ConversationMessage[];
    status: 'active' | 'idle' | 'processing';
    folder?: vscode.WorkspaceFolder;
}> = new Map();

private _activeAgentId: string | undefined;
```

---

## 3B. CLAUDE CODE CLI ARCHITECTURE (External Reference)

### Session Management (CLI-level)

**Storage Locations**:
```
~/.claude/
├── history.jsonl              # All session metadata
├── projects/
│   └── [encoded-path]/        # Per-project sessions
│       ├── [session-id].jsonl # Full transcript
│       └── [summary].jsonl    # Compacted summary
├── session-env/               # Session environment
└── settings.json              # Global settings
```

### Multi-Agent Capabilities (CLI-level)

Claude Code CLI has **native subagent support**:
- Each subagent runs in isolated context window
- Can be specialized (code-reviewer, test-runner, etc.)
- Defined in `.claude/agents/*.md`

**Key Limitations**:
- Subagents cannot spawn other subagents
- No built-in cross-session notification
- Session-per-project isolation

### IPC/Extension Integration Options

1. **CLI stream-json Mode** (CURRENTLY USED)
   - Bidirectional JSON streaming via stdin/stdout
   - Supports `--resume` for session continuity
   - Permission prompts via `control_request` messages

2. **CLI Headless Mode** (`claude -p "prompt"`)
   - Single-shot, non-interactive
   - Good for automation scripts

3. **MCP Servers**
   - External tool integration
   - Can expose custom tools to Claude

4. **Hooks Framework**
   - Event-driven automation
   - `PreToolUse`, `PostToolUse`, `SessionStart`, etc.

---

## 4. VS CODE API CAPABILITIES

### File System Access

**YES** - Extensions have full file system access via `workspace.fs`:
```typescript
await vscode.workspace.fs.readFile(uri);
await vscode.workspace.fs.writeFile(uri, content);
await vscode.workspace.fs.readDirectory(uri);
```

### Multi-Root Workspaces

**YES** - Can access multiple folders:
```typescript
const folders = vscode.workspace.workspaceFolders;
const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri);
```

### Multiple Webview Panels

**YES** - Can create multiple independent panels:
```typescript
const panel1 = vscode.window.createWebviewPanel('agent-1', 'Agent 1', ...);
const panel2 = vscode.window.createWebviewPanel('agent-2', 'Agent 2', ...);
```

### Notification System

**Available APIs**:
- `window.showInformationMessage()` - Info notifications
- `window.showWarningMessage()` - Warning notifications
- `window.showErrorMessage()` - Error notifications
- `window.withProgress()` - Progress indicators
- `StatusBarItem` - Status bar items with badges

---

## 5. MULTI-AGENT DESIGN

### Use Cases
1. **Same folder, different tasks**: "Research" agent vs "Build" agent
2. **Different folders**: Multiple projects open
3. **Parallel work**: Background tasks while main agent works

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Manager                         │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Agent 1      │  │ Agent 2      │  │ Agent 3      │  │
│  │ "Research"   │  │ "Build"      │  │ "Test"       │  │
│  │ [Active]     │  │ [Background] │  │ [Idle]       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │          │
│         └────────────────┬┴──────────────────┘          │
│                          │                              │
│  ┌───────────────────────▼─────────────────────────┐   │
│  │           Notification Hub                       │   │
│  │  - Agent completed task                          │   │
│  │  - Agent needs input                            │   │
│  │  - Agent encountered error                      │   │
│  └─────────────────────────────────────────────────┘   │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Agent Identification

**Options for distinguishing agents**:

1. **Named Agents**: User assigns names ("Research", "Build", "Deploy")
2. **Color-coded**: Each agent has unique color in UI
3. **Folder-based**: Auto-name by workspace folder
4. **Task-based**: Name by current task ("Building auth feature")

### Notification System

**Proposed Implementation**:
```typescript
interface AgentNotification {
    agentId: string;
    agentName: string;
    type: 'completed' | 'needs_input' | 'error' | 'info';
    title: string;
    message: string;
    actions?: NotificationAction[];
}

class NotificationHub {
    async notify(notification: AgentNotification) {
        // 1. Status bar update
        this.updateStatusBar(notification);

        // 2. VS Code notification (for important events)
        if (notification.type === 'completed' || notification.type === 'error') {
            vscode.window.showInformationMessage(
                `[${notification.agentName}] ${notification.title}`,
                ...notification.actions?.map(a => a.label) || []
            );
        }

        // 3. Sound cue (optional)
        if (this.soundEnabled) {
            this.playNotificationSound(notification.type);
        }

        // 4. Browser voice bridge (if open)
        this.voiceBridge?.sendNotification(notification);
    }
}
```

### Agent Switching

**Methods**:
1. **Quick picker**: `Cmd+Shift+A` opens agent picker
2. **Status bar click**: Click current agent to switch
3. **Tab-based**: Each agent as a webview tab
4. **Voice command**: "Switch to research agent"

---

## 6. IMPLEMENTATION PLAN

### Phase 1: Performance & Basic UX (1-2 days)
- [ ] Implement sentence-level TTS chunking
- [ ] Add playback controls to browser page (pause, mute, volume)
- [ ] Add spacebar push-to-talk in browser
- [ ] Add visual feedback (speaking indicator, processing indicator)

### Phase 2: Continuous Listening (2-3 days)
- [ ] Integrate `@ricky0123/vad-web` for VAD
- [ ] Add auto-listen mode (record after TTS finishes)
- [ ] Add keyboard shortcuts (Space, Esc, M)
- [ ] Improve mobile/iPad touch UX

### Phase 3: Multi-Agent Foundation (3-4 days)
- [ ] Create `AgentManager` class
- [ ] Support multiple named agents
- [ ] Add agent switching UI (quick picker, status bar)
- [ ] Implement notification hub
- [ ] Add agent-specific status bar items

### Phase 4: Advanced Features (Future)
- [ ] Wake word detection with Porcupine
- [ ] Cross-agent communication
- [ ] Agent templates (research, build, test)
- [ ] Voice-based agent switching

---

## 7. DEPENDENCIES TO ADD

```json
{
  "dependencies": {
    "@ricky0123/vad-web": "^0.0.7"
  },
  "optionalDependencies": {
    "@picovoice/porcupine-web": "^3.0.0"
  }
}
```

**Note**: VAD library runs in browser, not Node.js extension host.

---

## 8. QUICK WINS (Implement Now)

### 1. Reduce TTS Lag - Sentence Chunking
```typescript
// In extension.ts, update sendTTSToVoiceBridge
private async sendTTSToVoiceBridge(text: string): Promise<void> {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

    for (const sentence of sentences) {
        if (sentence.trim()) {
            this._voiceBridge?.sendTTSResponse(sentence.trim());
            // Small delay between sentences for natural pacing
            await new Promise(r => setTimeout(r, 100));
        }
    }
}
```

### 2. Add Keyboard Shortcuts to Browser Page
Already in current implementation, but enhance with:
- Visual indicator showing shortcut hints
- Esc to cancel recording
- M to toggle mute

### 3. Add Playback Queue
```javascript
// In browser page script
class AudioQueue {
    constructor() {
        this.queue = [];
        this.isPlaying = false;
        this.isPaused = false;
        this.currentAudio = null;
    }

    add(audioData, text) {
        this.queue.push({ audioData, text });
        if (!this.isPlaying) this.playNext();
    }

    async playNext() {
        if (this.queue.length === 0) {
            this.isPlaying = false;
            return;
        }

        this.isPlaying = true;
        const { audioData, text } = this.queue.shift();

        this.currentAudio = new Audio(audioData);
        this.currentAudio.onended = () => this.playNext();

        if (!this.isPaused) {
            await this.currentAudio.play();
        }
    }

    pause() {
        this.isPaused = true;
        this.currentAudio?.pause();
    }

    resume() {
        this.isPaused = false;
        this.currentAudio?.play();
    }

    stop() {
        this.queue = [];
        this.currentAudio?.pause();
        this.isPlaying = false;
    }
}
```

---

## Summary

**Key Findings**:
1. TTS lag is caused by waiting for full audio - fix with sentence chunking
2. Browser UX can be improved with push-to-talk, VAD, and playback controls
3. VS Code API supports multiple webview panels and file system access
4. Claude Code has native subagent support but no cross-session notifications
5. Multi-agent system requires custom notification hub

**Recommended Priority**:
1. **Immediate**: Sentence chunking for TTS, add playback controls
2. **Short-term**: Push-to-talk + VAD, keyboard shortcuts
3. **Medium-term**: Multi-agent foundation, notification system
4. **Long-term**: Wake word detection, voice-based agent switching
