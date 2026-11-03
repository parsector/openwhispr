import { useEffect } from "react";
import { useLocalStorage } from "./useLocalStorage";

export function useSubTab<T extends string>(
  storageKey: string,
  options: readonly T[],
  initial?: T
) {
  const [tab, setTab] = useLocalStorage<T>(storageKey, initial ?? options[0]);
  useEffect(() => {
    if (initial && initial !== tab) setTab(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);
  const safeTab = options.includes(tab) ? tab : options[0];
  return [safeTab, setTab] as const;
}
