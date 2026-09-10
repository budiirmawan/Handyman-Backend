/**
 * HC-00 PART 01 — Handyman bounded-context identity.
 *
 * Permanent constants shared by all future `handyman-*` modules.
 * No business behavior lives here; Handyman lifecycle, pricing, commercial,
 * payment, and warranty behavior belongs to later HC waves.
 */
export const HANDYMAN_CONTEXT_NAME = 'handyman' as const;

export type HandymanContextName = typeof HANDYMAN_CONTEXT_NAME;

/**
 * Permanent API namespace for the Handyman bounded context.
 * All Handyman routes must live under this namespace.
 */
export const HANDYMAN_API_NAMESPACE = '/handyman' as const;
