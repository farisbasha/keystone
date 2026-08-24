import { useEffect } from 'react'

import { useKeystone } from '../context.tsx'

export function usePreventNavigation(shouldPreventNavigationRef: { current: boolean }) {
  const { navigationBlockers } = useKeystone()
  useEffect(
    () => navigationBlockers.add(() => shouldPreventNavigationRef.current),
    [navigationBlockers, shouldPreventNavigationRef]
  )
}
