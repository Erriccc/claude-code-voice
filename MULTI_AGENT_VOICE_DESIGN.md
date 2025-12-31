# Multi-Agent Voice Command Center - Architecture Design

## Vision

The browser voice bridge becomes a **central command center** for controlling multiple Claude agents across different workspaces/folders. Users can:

1. **Talk to multiple agents** - Each agent handles a different task/folder
2. **Control who speaks** - Queue, prioritize, or interrupt agent responses
3. **Navigate by voice** - "Switch to research agent", "What's the build agent doing?"
4. **Receive notifications** - Audio cues when agents complete tasks or need attention
5. **Multi-device** - Open browser bridge on iPad/phone while coding on laptop

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    BROWSER VOICE COMMAND CENTER                          │
│                    (iPad, Phone, or Secondary Screen)                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      Agent Switcher                              │    │
│  │  [🔵 Research] [🟢 Build] [🟡 Test] [+ Add Agent]               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Active: Research Agent                          📁 ~/project-a  │    │
│  │  Status: Responding...                                           │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌───────────┐  Playback Controls: [⏸️ Pause] [⏹️ Stop] [🔇 Mute]   │
│  │    🎤     │                                                       │
│  │  [SPACE]  │  Voice Commands:                                      │
│  └───────────┘  "Hey Claude" / "Switch to build" / "What's next?"   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Response Queue:                                                 │    │
│  │  1. [Research] Analyzing codebase... (playing)                  │    │
│  │  2. [Build] Compilation complete! (waiting)                     │    │
│  │  3. [Test] 3 tests failed (waiting)                             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Conversation (Research Agent)                                   │    │
│  │  You: "What authentication methods are used?"                   │    │
│  │  Claude: "The codebase uses JWT tokens with..."                 │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ WebSocket/SSE
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         VS CODE EXTENSION HOST                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                     AGENT MANAGER                                 │   │
│  │                                                                   │   │
│  │  agents: Map<string, Agent>                                      │   │
│  │  activeAgentId: string                                           │   │
│  │  responseQueue: ResponseQueueItem[]                              │   │
│  │                                                                   │   │
│  │  Methods:                                                         │   │
│  │  - createAgent(name, folder)                                     │   │
│  │  - switchAgent(id)                                               │   │
│  │  - sendToAgent(id, message)                                      │   │
│  │  - getAgentStatus(id)                                            │   │
│  │  - queueResponse(agentId, response)                              │   │
│  │  - playNextResponse()                                            │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                            │                                             │
│         ┌──────────────────┼──────────────────┐                         │
│         ▼                  ▼                  ▼                         │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                   │
│  │ Agent:      │   │ Agent:      │   │ Agent:      │                   │
│  │ "Research"  │   │ "Build"     │   │ "Test"      │                   │
│  │             │   │             │   │             │                   │
│  │ folder: ~/a │   │ folder: ~/b │   │ folder: ~/a │                   │
│  │ session: x  │   │ session: y  │   │ session: z  │                   │
│  │ process: ✓  │   │ process: ✓  │   │ process: -  │                   │
│  │ status: busy│   │ status: idle│   │ status: idle│                   │
│  └─────────────┘   └─────────────┘   └─────────────┘                   │
│         │                  │                  │                         │
│         ▼                  ▼                  ▼                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    CLAUDE CLI PROCESSES                          │   │
│  │  Each agent spawns its own claude process with --resume          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Concepts

### 1. Agent

An agent is a named Claude session associated with a specific task or folder.

```typescript
interface Agent {
    id: string;                           // Unique identifier
    name: string;                         // User-friendly name ("Research", "Build")
    color: string;                        // Color for UI (hex)
    folder: string;                       // Workspace folder path
    sessionId: string | undefined;        // Claude CLI session ID
    process: ChildProcess | undefined;    // Active Claude process
    status: AgentStatus;                  // Current state
    conversation: Message[];              // Chat history
    lastActivity: number;                 // Timestamp
    notifications: Notification[];        // Pending notifications
}

type AgentStatus =
    | 'idle'           // Ready for input
    | 'processing'     // Waiting for Claude response
    | 'responding'     // Claude is responding (streaming)
    | 'waiting'        // Has response queued, waiting to be heard
    | 'error';         // Error state
```

### 2. Response Queue

When multiple agents have responses, they queue up instead of talking over each other.

```typescript
interface QueuedResponse {
    id: string;
    agentId: string;
    agentName: string;
    text: string;
    audioChunks: AudioChunk[];      // Pre-generated TTS chunks
    priority: 'normal' | 'high';    // High = errors, completions
    timestamp: number;
    status: 'queued' | 'playing' | 'completed' | 'skipped';
}

// Queue behavior:
// 1. Responses queue in order received
// 2. High priority (errors, task completions) can jump queue
// 3. User can skip current response
// 4. User can select specific response to hear
// 5. User can clear queue
```

### 3. Voice Commands

Voice commands for controlling agents:

| Command | Action |
|---------|--------|
| "Hey Claude" | Wake word (start listening) |
| "Switch to [name]" | Change active agent |
| "What's [name] doing?" | Get agent status |
| "Stop" / "Pause" | Stop/pause current audio |
| "Skip" | Skip to next queued response |
| "Clear queue" | Clear all pending responses |
| "Mute [name]" | Mute notifications from agent |
| "New agent [name] in [folder]" | Create new agent |
| "Close [name]" | Close an agent |

### 4. Audio Cues

Different sounds for different events:

| Event | Sound |
|-------|-------|
| Agent starts responding | Soft chime |
| Agent completes task | Success tone |
| Agent error | Alert tone |
| Agent needs input | Question tone |
| Switching agents | Switch sound |
| Queue item added | Subtle pop |

---

## User Flows

### Flow 1: Multi-Agent Setup

```
User: Opens VS Code with project
User: Opens browser bridge on iPad
User: "Create agent Research for understanding the codebase"
System: Creates Research agent in current folder
User: "Create agent Build for implementing features"
System: Creates Build agent in current folder

User now has two agents, can talk to either
```

### Flow 2: Parallel Work

```
User: "Research, what authentication is used?"
Research Agent: Starts analyzing...

User: "Build, add a logout button to the navbar"
Build Agent: Starts working...

[Research finishes first]
System: Plays Research response
System: "Research says: The app uses JWT tokens stored in..."

[Build finishes]
System: Queues Build response
System: After Research done, plays Build response
```

### Flow 3: Priority Handling

```
[User talking to Research agent]
[Build agent encounters error]

System: Plays alert tone
System: "Build agent error: Cannot find module..."
System: Resumes Research response (or user can address Build)
```

### Flow 4: Agent Switching

```
User: "Switch to Build"
System: "Switched to Build agent"
System: Shows Build conversation history
User: "What did you change?"
Build: Responds with recent changes
```

---

## Implementation Phases

### Phase 1: Foundation (Current Sprint)
- [ ] Streaming TTS with sentence-level chunking
- [ ] Basic playback controls (pause, stop, mute)
- [ ] Single agent improvements

### Phase 2: Multi-Agent Core
- [ ] Agent Manager class
- [ ] Create/switch/close agents
- [ ] Agent status tracking
- [ ] Response queue system

### Phase 3: Voice Control
- [ ] Voice command recognition
- [ ] Agent switching by voice
- [ ] Queue control by voice

### Phase 4: Browser Command Center
- [ ] Agent switcher UI
- [ ] Response queue display
- [ ] Per-agent conversation views
- [ ] Agent status indicators

### Phase 5: Advanced Features
- [ ] Wake word detection
- [ ] Audio cues/notifications
- [ ] Cross-folder navigation
- [ ] Agent templates

---

## Data Flow

### Message Flow (User → Agent)

```
1. User speaks in browser
2. Browser records audio, sends to extension
3. Extension transcribes via Whisper
4. Extension parses for voice commands
   - If voice command: Execute (switch agent, etc.)
   - If message: Send to active agent
5. Active agent's Claude process receives message
6. Response streams back
7. Extension chunks into sentences
8. TTS generated for each chunk
9. Audio queued for playback
10. Browser plays audio
```

### Response Queue Flow

```
1. Agent response complete
2. Create QueuedResponse with TTS chunks
3. Add to responseQueue
4. If nothing playing:
   - Start playing this response
5. If something playing:
   - Show in queue UI
   - Wait for current to finish
6. When response done:
   - Mark as completed
   - Play next in queue
```

---

## API Design

### Browser ↔ Extension Messages

```typescript
// Browser → Extension
interface BrowserMessage {
    type: 'audio' | 'command' | 'control';

    // For audio
    audio?: string;        // base64
    mimeType?: string;

    // For command
    command?: 'switchAgent' | 'createAgent' | 'closeAgent' |
              'pause' | 'resume' | 'stop' | 'skip' | 'clearQueue';
    agentId?: string;
    agentName?: string;
    folder?: string;
}

// Extension → Browser
interface ExtensionMessage {
    type: 'agents' | 'activeAgent' | 'queue' | 'tts' |
          'status' | 'transcript' | 'notification';

    // For agents
    agents?: AgentInfo[];

    // For activeAgent
    agentId?: string;

    // For queue
    queue?: QueuedResponseInfo[];

    // For tts
    audio?: string;
    text?: string;
    isLast?: boolean;

    // For notification
    notification?: {
        agentId: string;
        type: 'complete' | 'error' | 'input_needed';
        message: string;
    };
}
```

---

## Settings

```json
{
    "claudeCodeChat.voice.multiAgent.enabled": true,
    "claudeCodeChat.voice.multiAgent.maxAgents": 5,
    "claudeCodeChat.voice.queue.autoPlay": true,
    "claudeCodeChat.voice.queue.prioritizeErrors": true,
    "claudeCodeChat.voice.cues.enabled": true,
    "claudeCodeChat.voice.cues.volume": 0.5,
    "claudeCodeChat.voice.wakeWord.enabled": false,
    "claudeCodeChat.voice.wakeWord.phrase": "Hey Claude"
}
```

---

## Questions to Resolve

1. **Agent Persistence**: Should agents persist across VS Code restarts?
2. **Cross-Instance**: Can agents span multiple VS Code windows?
3. **Concurrent Responses**: Should agents be able to respond simultaneously (overlapping audio)?
4. **Default Agent**: Auto-create agent for current folder on extension start?
5. **Voice Command Accuracy**: How to handle misheard agent names?

---

## Next Steps

1. **Implement streaming TTS** - Foundation for responsive audio
2. **Create AgentManager** - Core multi-agent logic
3. **Update Browser UI** - Agent switcher, queue display
4. **Add voice commands** - Basic switching and control
5. **Test with 2-3 agents** - Validate the flow
