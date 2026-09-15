// Tool contract: what a tool looks like to the session.
// Implementations live in tools/, kept separate from core.

export interface AgentTool {
    name: string;
    description: string;
    /** JSON Schema for the arguments object. */
    parameters: Record<string, unknown>;
    /** Server-side implementation. Whatever it returns is JSON-serialized
     *  back to the model as the function result. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any) => Promise<unknown> | unknown;
}

/** Shape the Realtime API expects in session.update → tools. */
export function toRealtimeTool(tool: AgentTool): Record<string, unknown> {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    };
}
