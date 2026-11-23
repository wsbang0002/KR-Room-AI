export const comparisonGeminiModel = 'gemini-3.5-flash-lite';

export function primaryGeminiModel(env = process.env) {
 return env.GEMINI_PRIMARY_MODEL || env.GEMINI_MODEL || 'gemini-3.6-flash';
}

export function geminiThinkingLevel(model) {
 if (model === comparisonGeminiModel) return 'minimal';
 if (/^gemini-3\./.test(model)) return 'low';
}

// generateContent takes a nested object. Interactions takes the level directly.
export function geminiThinkingConfig(model) {
 const thinkingLevel = geminiThinkingLevel(model);
 return thinkingLevel ? {thinkingLevel} : undefined;
}
