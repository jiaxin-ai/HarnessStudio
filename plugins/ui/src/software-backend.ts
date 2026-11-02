import { createContext, useContext } from 'react';
import type { SoftwareBackend } from '../../studio/src/seat-types.ts';

/** The deployment's software backend, from GET /api/studio/status (softwareBackend), which client.tsx already polls.
 * Undefined before the first status and with older servers; the page then behaves as it always did. */
export const SoftwareBackendContext = createContext<SoftwareBackend | undefined>(undefined);
export const useSoftwareBackend = (): SoftwareBackend | undefined => useContext(SoftwareBackendContext);
/** No software at all (STUDIO_SEAT_BACKEND=none): no software area, VM settings, VM budget or recordings. */
export const useNoSoftware = (): boolean => useSoftwareBackend() === 'none';
