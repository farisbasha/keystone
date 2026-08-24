export type NavigationBlockers = {
  /** Registers a blocker that returns true while there are unsaved changes. Returns a cleanup function. */
  add: (blocker: () => boolean) => () => void
  /** Whether any registered blocker currently has unsaved changes. */
  hasUnsavedChanges: () => boolean
  /** Asks the user to confirm leaving if there are unsaved changes; true means cancel navigation. */
  shouldBlockNavigation: () => boolean
}

export function createNavigationBlockers(): NavigationBlockers {
  const blockers = new Set<() => boolean>()

  function hasUnsavedChanges() {
    for (const blocker of blockers) {
      if (blocker()) return true
    }
    return false
  }

  return {
    add(blocker) {
      blockers.add(blocker)
      return () => {
        blockers.delete(blocker)
      }
    },
    hasUnsavedChanges,
    shouldBlockNavigation() {
      return (
        hasUnsavedChanges() &&
        !window.confirm('There are unsaved changes, are you sure you want to exit?')
      )
    },
  }
}
