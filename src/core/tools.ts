// Tool contract: what a tool looks like to the session.
// A tool is defined once with a Zod schema; from it we derive both the JSON
// Schema the Realtime API needs and the validated, typed args the handler
// receives. Implementations live in tools/, kept separate from core.

import { z } from 'zod';

export interface AgentTool<TArgs = unknown> {
    name: string;
    description: string;
    /** Argument schema. Source of truth for both the model and the handler. */
    args: z.ZodType<TArgs>;
    /** Server-side implementation. Whatever it returns is JSON-serialized
     *  back to the model as the function result. */
    handler: (args: TArgs) => Promise<unknown> | unknown;
}

export function defineTool<TArgs>(tool: AgentTool<TArgs>): AgentTool<TArgs> {
    return tool;
}

/** Result of validating the model's raw `arguments` string. */
export type ParsedArgs<TArgs> =
    | { ok: true; args: TArgs }
    | { ok: false; error: ToolError };

/** Shape returned to the model when a call cannot run. */
export interface ToolError {
    error: 'unknown_tool' | 'invalid_arguments' | 'tool_execution_failed';
    message: string;
    /** Per-field problems for invalid_arguments, so the model can correct itself. */
    issues?: { path: string; message: string }[];
}

/** Parse + validate the raw JSON string the model sent as function arguments. */
export function parseToolArgs<TArgs>(tool: AgentTool<TArgs>, rawArgs: string): ParsedArgs<TArgs> {
    let json: unknown;
    try {
        json = rawArgs ? JSON.parse(rawArgs) : {};
    } catch (err) {
        return {
            ok: false,
            error: { error: 'invalid_arguments', message: `arguments are not valid JSON: ${(err as Error).message}` },
        };
    }
    const result = tool.args.safeParse(json);
    if (result.success) return { ok: true, args: result.data };
    return {
        ok: false,
        error: {
            error: 'invalid_arguments',
            message: `arguments for ${tool.name} failed validation`,
            issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
    };
}

/** Shape the Realtime API expects in session.update → tools. */
export function toRealtimeTool(tool: AgentTool<any>): Record<string, unknown> {
    const { $schema: _, ...parameters } = z.toJSONSchema(tool.args, { target: 'draft-7' });
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters,
    };
}
