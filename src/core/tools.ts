// Tool contract: what a tool looks like to the session.
// A tool is defined once with a Zod schema; from it we derive both the JSON
// Schema the Realtime API needs and the validated, typed args the handler
// receives. Implementations live in tools/, kept separate from core.

import { z } from 'zod';

import type { CallState } from './state';

/** What the handler can reach beyond its arguments. */
export interface ToolContext {
    state: CallState;
}

export interface AgentTool<TArgs = unknown> {
    name: string;
    description: string;
    /** Argument schema. Source of truth for validation and the handler's types. */
    args: z.ZodType<TArgs>;
    /** Optional schema shown to the model instead of `args` (e.g. to hide or
     *  reshape values). Validation always uses `args`. */
    exposedArgs?: z.ZodType;
    /**
     * silent: the model continues the conversation without mentioning the call.
     * report: the model acknowledges it checked and shares the result.
     */
    mode: 'silent' | 'report';
    /**
     * Opt-in: the agent speaks one short filler sentence while the handler runs,
     * e.g. "checking the schedule" → "One moment, let me check the schedule."
     * The result is spoken at least SPEECH_GAP_MS after the filler audio ends.
     * Unused today: the reply that calls the tool says "let me check…" itself.
     */
    filler?: string;
    /** Server-side implementation. Whatever it returns is JSON-serialized
     *  back to the model as the function result. */
    handler: (args: TArgs, ctx: ToolContext) => Promise<unknown> | unknown;
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
    hint?: string;
}

export function isToolError(value: unknown): value is ToolError {
    return typeof value === 'object' && value !== null && typeof (value as ToolError).error === 'string';
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
            hint: 'Call again using exactly the values expected in issues. They override anything '
                + 'else you were told about this field.',
        },
    };
}

/** Shape the Realtime API expects in session.update → tools. */
export function toRealtimeTool(tool: AgentTool<any>): Record<string, unknown> {
    const { $schema: _, ...parameters } = z.toJSONSchema(tool.exposedArgs ?? tool.args, { target: 'draft-7' });
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters,
    };
}
