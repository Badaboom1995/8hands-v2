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
    /** Booking questions, asked word for word. */
    questions: {
        service: string;
        finishManicure: string;
        finishPedicure: string;
        extensionsType: string;
        extensionsLength: string;
        location: string;
        level: string;
        design: string;
        day: string;
    };
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
     * names, most specific first ("TOP MASTER" is Top, not Master).
     */
    levels: { name: string; words: string[] }[];
    /** Provider locations the agent books for, by name. Others (e.g. a default test location) are ignored. */
    studios: string[];
}

export const ZORINA: BusinessProfile = {
    agentName: 'Maya',
    greeting: 'Hi, thanks for calling Zorina Nail Studio! How can I help you today?',
    businessName: 'Zorina Nail Studio',
    businessType: 'a nail salon',
    city: 'San Francisco',
    timezone: 'America/Los_Angeles',
    languages: 'English',
    aiDisclosure: 'I\'m Zorina\'s virtual receptionist, and I can help with services and appointments.',
    questions: {
        service: 'Are you booking a manicure or a pedicure?',
        finishManicure: 'Would you like gel, regular polish, or no color?',
        finishPedicure: 'Would you like a pedicure with gel, regular polish, or no color?',
        extensionsType: 'Would you like a refill, or are you looking for a new set?',
        extensionsLength: 'What length would you like — short, medium, or long?',
        location: 'Which location works best for you — Union Street or Pacific Avenue?',
        level: 'Which level of technician would you like — Junior, Master, or Top?',
        design: 'Would you like to add a nail design, or is there anything special you\'d like?',
        day: 'What day and time would work for you?',
    },
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
    // The workflow doc says no Gel-X; the v1 config says treat it as extensions. Ask Anastasia.
    notOffered: 'Gel-X',
    levels: [
        { name: 'Top', words: ['top'] },
        { name: 'Junior', words: ['junior'] },
        { name: 'Master', words: ['master'] },
    ],
    studios: ['Pacific Avenue', 'Union Street'],
};

/** The business this process serves. One tenant for now. */
export const BUSINESS = ZORINA;
