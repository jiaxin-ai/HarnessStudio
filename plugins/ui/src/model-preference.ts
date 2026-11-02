export interface ModelPreference {
  provider: string;
  model: string;
}

export const modelPreferenceStorageKey = 'harnessstudio:last-used-model:v1';

function modelPreference(value: unknown): ModelPreference | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { provider, model } = value as Partial<ModelPreference>;
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) return undefined;
  return { provider, model };
}

export function readModelPreference(): ModelPreference | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(modelPreferenceStorageKey);
    return saved ? modelPreference(JSON.parse(saved)) : undefined;
  } catch {
    return undefined;
  }
}

export function saveModelPreference(value: ModelPreference): void {
  try {
    const preference = modelPreference(value);
    if (preference) globalThis.localStorage?.setItem(modelPreferenceStorageKey, JSON.stringify(preference));
  } catch {
    // Storage may be unavailable or full; choosing a model should still work.
  }
}

export function availableModelPreference<T extends ModelPreference>(preference: ModelPreference | undefined, choices: readonly T[]): T | undefined {
  return preference && choices.find(choice => choice.provider === preference.provider && choice.model === preference.model);
}
