// Per-call token/cost accounting for the Realtime API.

// USD per 1M tokens; verify against the OpenAI price list when models change.
const PRICE_TABLE: Record<string, {
    textIn: number; textOut: number; audioIn: number; audioOut: number;
    cachedText: number; cachedAudio: number;
}> = {
    'gpt-realtime-2.1': { textIn: 4, textOut: 24, audioIn: 32, audioOut: 64, cachedText: 0.4, cachedAudio: 0.4 },
    'gpt-realtime-2.1-mini': { textIn: 0.6, textOut: 2.4, audioIn: 10, audioOut: 20, cachedText: 0.06, cachedAudio: 0.3 },
};
const FALLBACK_MODEL = 'gpt-realtime-2.1';

// Caller-speech transcription (billed separately from the realtime model). USD per 1M tokens.
const TRANSCRIBE_PRICE = { audioIn: 3, textIn: 1.25, textOut: 5, perMinute: 0.003 };
export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

/** `usage` of conversation.item.input_audio_transcription.completed: tokens or duration. */
export function transcriptionCostUsd(usage: any): number {
    if (!usage) return 0;
    if (usage.type === 'duration') return (usage.seconds || 0) / 60 * TRANSCRIBE_PRICE.perMinute;
    const det = usage.input_token_details || {};
    const audio = det.audio_tokens ?? usage.input_tokens ?? 0;
    const text = det.text_tokens ?? 0;
    return (audio * TRANSCRIBE_PRICE.audioIn + text * TRANSCRIBE_PRICE.textIn
        + (usage.output_tokens || 0) * TRANSCRIBE_PRICE.textOut) / 1_000_000;
}

export interface TurnStats {
    input: number;
    output: number;
    cached: number;
    cachePct: number;
    cost: number;
}

export interface CallTotals {
    turns: number;
    input: number;
    output: number;
    cached: number;
    cost: number;
    cachePct: number;
}

// Realtime `response.done` usage payload (the parts we read).
export interface RealtimeUsage {
    input_tokens?: number;
    output_tokens?: number;
    input_token_details?: {
        text_tokens?: number;
        audio_tokens?: number;
        cached_tokens?: number;
        cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
    };
    output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

export class CallStats {
    private readonly price: (typeof PRICE_TABLE)[string];

    private turns = 0;
    private input = 0;
    private output = 0;
    private cached = 0;
    private cost = 0;

    constructor(model: string) {
        this.price = PRICE_TABLE[model] || PRICE_TABLE[FALLBACK_MODEL];
        if (!PRICE_TABLE[model]) {
            console.warn(`no price table for model "${model}" — cost shown using ${FALLBACK_MODEL} rates`);
        }
    }

    turnCostUsd(usage: RealtimeUsage): number {
        const inDet = usage.input_token_details || {};
        const outDet = usage.output_token_details || {};
        const cachedDet = inDet.cached_tokens_details || {};
        const cachedText = cachedDet.text_tokens || 0;
        const cachedAudio = cachedDet.audio_tokens || 0;
        const freshText = Math.max(0, (inDet.text_tokens || 0) - cachedText);
        const freshAudio = Math.max(0, (inDet.audio_tokens || 0) - cachedAudio);
        return (
            freshText * this.price.textIn
            + freshAudio * this.price.audioIn
            + cachedText * this.price.cachedText
            + cachedAudio * this.price.cachedAudio
            + (outDet.text_tokens || 0) * this.price.textOut
            + (outDet.audio_tokens || 0) * this.price.audioOut
        ) / 1_000_000;
    }

    addTurn(usage: RealtimeUsage): { turn: TurnStats; total: CallTotals } {
        const input = usage.input_tokens || 0;
        const output = usage.output_tokens || 0;
        const cached = usage.input_token_details?.cached_tokens || 0;
        const cost = this.turnCostUsd(usage);

        this.turns += 1;
        this.input += input;
        this.output += output;
        this.cached += cached;
        this.cost += cost;

        return {
            turn: {
                input,
                output,
                cached,
                cachePct: input ? Math.round((cached / input) * 100) : 0,
                cost,
            },
            total: this.totals(),
        };
    }

    totals(): CallTotals {
        return {
            turns: this.turns,
            input: this.input,
            output: this.output,
            cached: this.cached,
            cost: this.cost,
            cachePct: this.input ? Math.round((this.cached / this.input) * 100) : 0,
        };
    }

    summaryLine(): string {
        const t = this.totals();
        return `${t.turns} turns, input ${t.input} (cached ${t.cached}, ${t.cachePct}%), `
            + `output ${t.output}, cost $${t.cost.toFixed(4)}`;
    }
}
