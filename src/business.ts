// Business profile: everything tenant-specific the agent needs — names, exact
// wording, policies, and how to read the provider's catalog. Data, not code;
// moves to the database when there is more than one business.

/** A catalog service (and option) by name, as the booking provider names it. */
export interface CatalogRef {
    service: string;
    option?: string;
    /** Done before the main service (e.g. removal). */
    before?: boolean;
}

export interface BusinessProfile {
    /** Stable tenant id (call logs, later the DB key). */
    id: string;
    agentName: string;
    /** Spoken verbatim as soon as the call connects. */
    greeting: string;
    businessName: string;
    /** "a nail salon" */
    businessType: string;
    city: string;
    /** IANA time zone the business speaks dates in, e.g. "America/Los_Angeles". */
    timezone: string;
    /** Spoken languages, e.g. "English". */
    languages: string;
    /** The only allowed answer to "are you an AI?". */
    aiDisclosure: string;
    /** How the agent sounds: who she sounds like, then tone and pacing rules. Style only; flow and rules live in the template. */
    voice: { persona: string; style: string[] };
    /** Booking questions, asked word for word. */
    questions: {
        service: string;
        finishManicure: string;
        finishPedicure: string;
        extensionsType: string;
        extensionsLength: string;
        location: string;
        phone: string;
        firstVisit: string;
        level: string;
        design: string;
        day: string;
    };
    /**
     * How the main service is said in a read-back, from area, finish, extensions
     * length and level: "Gel manicure, Master level", "Long extensions, Top level".
     */
    serviceWords: {
        area: Record<'manicure' | 'pedicure' | 'extensions', string>;
        finish: Record<'gel' | 'regular' | 'none', string>;
        length: Record<'short' | 'medium' | 'long', string>;
        /** "{level}" is replaced by the level name. */
        level: string;
    };
    /** Said word for word once the booking is made; the caller already heard the details in the read-back. */
    booked: string;
    /** Said word for word when the caller asks how the technician levels differ. */
    levelDifference: string;
    /** Design add-on levels with the caller-facing descriptors that identify each. */
    designLevels: Record<string, string>;
    /**
     * Extras booked on top of a main service, by key, with how the agent says each.
     * A standalone one (e.g. hand spa alone) is a main service, not an add-on.
     */
    addons: Record<string, string>;
    /** Catalog service for each design level; custom_request has none. */
    designServices: Record<string, CatalogRef>;
    /** Catalog service for each add-on key. */
    addonServices: Record<string, CatalogRef>;
    /** Said word for word when a card on file is required. */
    cardPolicy: string;
    /** Services callers ask for that the business does not offer, e.g. "Gel-X". */
    notOffered: string;
    /**
     * Technician levels and the catalog words that mark them in service or option
     * names, most specific first ("TOP MASTER" is Top, not Master). rank: higher is
     * the higher level, for a master listed on several.
     */
    levels: { name: string; words: string[]; rank: number }[];
    /** Provider locations the agent books for, by name. Others (e.g. a default test location) are ignored. */
    studios: string[];
    /**
     * Visit history rules (refill, free fix). Windows are calendar days in the
     * business time zone, inclusive. Services by provider item name.
     */
    history: {
        /** How far back to read bookings. */
        lookbackDays: number;
        /** Visits that count as extensions done here (a new set or a refill). */
        extensionServices: string[];
        /** Refill only when the last extensions visit was this many days ago. */
        refillDays: { min: number; max: number };
        /** A repair is free when the last visit was at most this many days ago. */
        freeFixDays: number;
        /** Repairs: they never start a new free-fix window themselves. */
        repairServices: string[];
    };
}

export const ZORINA: BusinessProfile = {
    id: 'zorina',
    agentName: 'Maya',
    greeting: 'Hi, thanks for calling Zorina Nail Studio! How can I help you today?',
    businessName: 'Zorina Nail Studio',
    businessType: 'a nail salon',
    city: 'San Francisco',
    timezone: 'America/Los_Angeles',
    languages: 'English',
    aiDisclosure: 'I\'m Zorina\'s virtual receptionist, and I can help with services and appointments.',
    voice: {
        persona: 'a calm, composed young woman: natural and human, never robotic or monotone',
        style: [
            'Warm, sincere, and reassuring; competent and in control.',
            'If the caller is upset or confused, acknowledge it first, apologize sincerely, then offer a clear next step.',
            'Explaining a problem: a little slower, with short natural pauses. Offering options or next steps: a little faster and more energetic, still controlled.',
            'A natural, friendly pace overall: never rushed, never dragged out.',
            'Slow down slightly and articulate clearly for names, services, dates, times, prices, and phone numbers.',
            'Never say "Of course". Don\'t open with "Sure" or "Absolutely"; respond directly. Use "Great" or "Perfect" only when it genuinely fits.',
        ],
    },
    questions: {
        service: 'Are you booking a manicure or a pedicure?',
        finishManicure: 'Would you like gel, regular polish, or no color?',
        finishPedicure: 'Would you like a pedicure with gel, regular polish, or no color?',
        extensionsType: 'Would you like a refill, or are you looking for a new set?',
        extensionsLength: 'What length would you like — short, medium, or long?',
        location: 'Which location works best for you — Union Street or Pacific Avenue?',
        phone: 'What phone number should I put the appointment under?',
        // v1 playbook visit_status, word for word.
        firstVisit: 'Have you been to us before, or is this your first visit?',
        level: 'Which level of technician would you like — Junior, Master, or Top?',
        design: 'Would you like to add a nail design, or is there anything special you\'d like?',
        day: 'What day and time would work for you?',
    },
    serviceWords: {
        area: { manicure: 'manicure', pedicure: 'pedicure', extensions: 'extensions' },
        finish: { gel: 'gel', regular: 'regular polish', none: 'no-color' },
        length: { short: 'short', medium: 'medium', long: 'long' },
        level: '{level} level',
    },
    booked: 'Done, you\'re all set. Thank you for calling!',
    levelDifference: 'The higher the level, the more experienced the technician: the appointment is faster '
        + 'and costs a bit more. Complex designs are done by our Top technicians.',
    // From the Square "Designs" item descriptions.
    designLevels: {
        simple: 'cat eye, or a minimal design on one nail',
        medium: 'French tip, chrome, ombre',
        hard: 'at least two colors on all nails plus lines, dots, or art',
        extra_hard: '3+ colors, intricate art, or several detailed accents',
        xxtra_hard: '5+ colors, or different art on each nail',
        extra_per_nail: 'charms, crystals, 3D details on some nails',
    },
    addons: {
        hand_spa: 'hand spa',
        removal: 'acrylic or dip removal',
        nail_extension: 'one-nail extension',
    },
    designServices: {
        simple: { service: 'Designs', option: 'Simple Level Design' },
        medium: { service: 'Designs', option: 'Medium Level Design' },
        hard: { service: 'Designs', option: 'Hard Level Design' },
        extra_hard: { service: 'Designs', option: 'Extra Hard Design' },
        xxtra_hard: { service: 'Designs', option: 'XXTra Hard Design' },
        extra_per_nail: { service: 'Designs', option: 'Extra per nail' },
    },
    addonServices: {
        hand_spa: { service: 'Hand Spa' },
        removal: { service: 'Acrylic/dip powder nail removal', before: true },
        nail_extension: { service: 'Extension for 1 nail' },
    },
    // Playbook exact text (policyContext + bookingPolicy.cancellation.exactText).
    cardPolicy: 'A valid card on file is required for every appointment. '
        + 'Same-day cancellations are charged 100% of the scheduled service price. '
        + 'Cancellations made with less than 24 hours notice are charged 50% of the scheduled service price.',
    // Confirmed with the owner (2026-10-08): no Gel-X.
    notOffered: 'Gel-X',
    levels: [
        { name: 'Top', words: ['top'], rank: 3 },
        { name: 'Junior', words: ['junior'], rank: 1 },
        { name: 'Master', words: ['master'], rank: 2 },
    ],
    studios: ['Pacific Avenue', 'Union Street'],
    // Owner (2026-10-08): outside the refill window → front desk; any visit counts for a
    // free fix; day 7 inclusive; a paid repair can be done by any master.
    history: {
        lookbackDays: 90,
        extensionServices: ['Nail Extension', 'Nail Extension Refill'],
        refillDays: { min: 28, max: 35 },
        freeFixDays: 7,
        repairServices: ['FREE Fix', 'Extension for 1 nail'],
    },
};

/** The business this process serves. One tenant for now. */
export const BUSINESS = ZORINA;
