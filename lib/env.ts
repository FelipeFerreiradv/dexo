/**
 * Environment and runtime detection utilities
 * Safe for SSR/Server Components - no direct window access at module level
 */

/**
 * Check if running on localhost (browser-side only)
 * Returns false on server-side during SSR
 */
export function isLocalhost(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  return window.location.hostname === 'localhost'
}

/**
 * Hook version for use in React components
 * Can be called at component render level but will be safe
 */
import { useMemo } from 'react'

export function useIsLocalhost(): boolean {
  return useMemo(() => isLocalhost(), [])
}
