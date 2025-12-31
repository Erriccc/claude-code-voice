/**
 * AgentManager - Foundation for multi-context/multi-agent support
 *
 * This module provides the data structures and basic management for
 * handling multiple Claude agents, each potentially working on different
 * folders or contexts.
 *
 * Current scope (foundation):
 * - Agent data structure and types
 * - Single agent management (default agent)
 * - Agent state tracking
 *
 * Future scope:
 * - Multiple concurrent agents
 * - Agent switching
 * - Response queue management across agents
 * - Voice commands for agent control
 */

import * as vscode from 'vscode';

/**
 * Agent status represents the current state of an agent
 */
export type AgentStatus =
    | 'idle'           // Ready for input
    | 'processing'     // Waiting for Claude response
    | 'responding'     // Claude is responding (streaming)
    | 'waiting'        // Has response queued, waiting to be heard
    | 'error';         // Error state

/**
 * Agent represents a Claude session with a specific context/folder
 */
export interface Agent {
    id: string;                           // Unique identifier
    name: string;                         // User-friendly name (e.g., "Research", "Build")
    color: string;                        // Color for UI (hex)
    folder: string;                       // Workspace folder path
    sessionId: string | undefined;        // Claude CLI session ID
    status: AgentStatus;                  // Current state
    lastActivity: number;                 // Timestamp of last activity
    isDefault: boolean;                   // Is this the default agent
}

/**
 * Agent creation options
 */
export interface CreateAgentOptions {
    name: string;
    folder?: string;
    color?: string;
    sessionId?: string;
}

/**
 * Agent info for UI display
 */
export interface AgentInfo {
    id: string;
    name: string;
    color: string;
    folder: string;
    status: AgentStatus;
    isActive: boolean;
}

/**
 * AgentManager handles creation, switching, and tracking of agents
 */
export class AgentManager {
    private agents: Map<string, Agent> = new Map();
    private activeAgentId: string | null = null;
    private context: vscode.ExtensionContext;

    // Default colors for agents
    private readonly defaultColors = [
        '#64ffda', // Teal (default)
        '#e94560', // Red
        '#ffd93d', // Yellow
        '#6c5ce7', // Purple
        '#00b894', // Green
    ];
    private colorIndex = 0;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.loadAgents();
    }

    /**
     * Load saved agents from workspace state
     */
    private loadAgents(): void {
        const savedAgents = this.context.workspaceState.get<Agent[]>('claude.agents', []);
        for (const agent of savedAgents) {
            this.agents.set(agent.id, agent);
            if (agent.isDefault) {
                this.activeAgentId = agent.id;
            }
        }
    }

    /**
     * Save agents to workspace state
     */
    private saveAgents(): void {
        const agentsArray = Array.from(this.agents.values());
        void this.context.workspaceState.update('claude.agents', agentsArray);
    }

    /**
     * Get the next available color
     */
    private getNextColor(): string {
        const color = this.defaultColors[this.colorIndex % this.defaultColors.length];
        this.colorIndex++;
        return color;
    }

    /**
     * Generate a unique agent ID
     */
    private generateId(): string {
        return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Create a new agent
     */
    createAgent(options: CreateAgentOptions): Agent {
        const id = this.generateId();
        const isDefault = this.agents.size === 0;

        const agent: Agent = {
            id,
            name: options.name,
            color: options.color || this.getNextColor(),
            folder: options.folder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
            sessionId: options.sessionId,
            status: 'idle',
            lastActivity: Date.now(),
            isDefault
        };

        this.agents.set(id, agent);

        // Set as active if it's the first/default agent
        if (isDefault) {
            this.activeAgentId = id;
        }

        this.saveAgents();
        return agent;
    }

    /**
     * Get or create the default agent
     */
    getOrCreateDefaultAgent(): Agent {
        // Look for existing default agent
        for (const agent of this.agents.values()) {
            if (agent.isDefault) {
                return agent;
            }
        }

        // Create default agent
        return this.createAgent({
            name: 'Default',
            folder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        });
    }

    /**
     * Get an agent by ID
     */
    getAgent(id: string): Agent | undefined {
        return this.agents.get(id);
    }

    /**
     * Get the currently active agent
     */
    getActiveAgent(): Agent | undefined {
        if (!this.activeAgentId) {
            return undefined;
        }
        return this.agents.get(this.activeAgentId);
    }

    /**
     * Switch to a different agent
     */
    switchAgent(id: string): Agent | undefined {
        const agent = this.agents.get(id);
        if (agent) {
            this.activeAgentId = id;
            agent.lastActivity = Date.now();
            this.saveAgents();
        }
        return agent;
    }

    /**
     * Update agent status
     */
    updateAgentStatus(id: string, status: AgentStatus): void {
        const agent = this.agents.get(id);
        if (agent) {
            agent.status = status;
            agent.lastActivity = Date.now();
            this.saveAgents();
        }
    }

    /**
     * Update agent session ID
     */
    updateAgentSessionId(id: string, sessionId: string): void {
        const agent = this.agents.get(id);
        if (agent) {
            agent.sessionId = sessionId;
            this.saveAgents();
        }
    }

    /**
     * Get all agents info for UI
     */
    getAllAgentsInfo(): AgentInfo[] {
        return Array.from(this.agents.values()).map(agent => ({
            id: agent.id,
            name: agent.name,
            color: agent.color,
            folder: agent.folder,
            status: agent.status,
            isActive: agent.id === this.activeAgentId
        }));
    }

    /**
     * Close/remove an agent
     */
    closeAgent(id: string): boolean {
        const agent = this.agents.get(id);
        if (!agent) {
            return false;
        }

        // Can't close the only agent
        if (this.agents.size === 1) {
            return false;
        }

        this.agents.delete(id);

        // If this was the active agent, switch to another
        if (this.activeAgentId === id) {
            const remainingAgent = this.agents.values().next().value;
            if (remainingAgent) {
                this.activeAgentId = remainingAgent.id;
            }
        }

        this.saveAgents();
        return true;
    }

    /**
     * Get agent by name (for voice commands)
     */
    getAgentByName(name: string): Agent | undefined {
        const lowerName = name.toLowerCase();
        for (const agent of this.agents.values()) {
            if (agent.name.toLowerCase() === lowerName) {
                return agent;
            }
        }
        return undefined;
    }

    /**
     * Get total number of agents
     */
    getAgentCount(): number {
        return this.agents.size;
    }

    /**
     * Check if there are multiple agents
     */
    hasMultipleAgents(): boolean {
        return this.agents.size > 1;
    }
}
