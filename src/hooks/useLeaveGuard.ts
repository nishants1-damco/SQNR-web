// Guards a page against accidental exits while unsaved or in-flight work
// would be lost (captured frames live only in memory; uploads and the AI pass
// die with the tab). Covers three exits:
//   - reload / close / external URL → the browser's native "Leave site?" prompt
//   - in-app navigation (links, back button) → a blocker the caller renders
//     with <LeaveGuardDialog>
//   - mobile pull-to-refresh → disabled via overscroll-behavior while active
import { useCallback, useEffect, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";

export function useLeaveGuard(when: boolean) {
  // Set just before the page's own programmatic navigate (e.g. to the finished
  // space) so the guard doesn't prompt for a navigation the flow intends.
  const allowRef = useRef(false);

  // Stable identity: useBlocker re-registers with history whenever these change.
  const shouldBlock = useCallback(() => !allowRef.current, []);

  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBlock,
    disabled: !when,
    withResolver: true,
  });

  useEffect(() => {
    if (!when) return;
    allowRef.current = false;
    const root = document.documentElement;
    const prevRoot = root.style.overscrollBehaviorY;
    const prevBody = document.body.style.overscrollBehaviorY;
    root.style.overscrollBehaviorY = "none";
    document.body.style.overscrollBehaviorY = "none";
    return () => {
      root.style.overscrollBehaviorY = prevRoot;
      document.body.style.overscrollBehaviorY = prevBody;
    };
  }, [when]);

  const allowLeave = useCallback(() => {
    allowRef.current = true;
  }, []);

  return { blocker, allowLeave };
}
