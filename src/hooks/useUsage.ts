import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAuth } from "./useAuth";
import { withSessionRefresh } from "../lib/auth";
import {
  getUsageState,
  isPastDueUsage,
  loadUsage,
  retryUsage,
  setUsageAccount,
  storeBillingOf,
  subscribeUsage,
  type StoreBilling,
  type UsageResponse,
  type UsageState,
} from "../lib/usageStore";

export interface UseUsageResult {
  /** Entitlement is only known when this is `"success"`. */
  status: UsageState["status"];
  isRefreshing: boolean;
  isRetrying: boolean;
  error: string | null;
  retry: () => Promise<void>;
  refetch: () => Promise<void>;
  /** `null` while the entitlement is unknown — never assume free. */
  hasPaidAccess: boolean | null;
  /**
   * `hasPaidAccess` with the unknown case resolved in the account's favour, for
   * gates where locking out a payer costs more than briefly over-granting
   * (the server stays authoritative).
   */
  hasPaidAccessOptimistic: boolean;
  plan: string;
  isPastDue: boolean;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  isSubscribed: boolean;
  isPersonallySubscribed: boolean;
  /** Set when the plan was bought in the mobile app. */
  storeBilling: StoreBilling | null;
  entitledWorkspaceIds: string[];
  isTrial: boolean;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  billingInterval: "monthly" | "annual" | null;
  isOverLimit: boolean;
  isApproachingLimit: boolean;
  resetAt: string | null;
}

async function fetchUsageResponse(): Promise<UsageResponse> {
  const cloudUsage = window.electronAPI?.cloudUsage;
  if (!cloudUsage) throw new Error("App not ready");
  return withSessionRefresh(async () => {
    const result = await cloudUsage();
    if (!result.success) {
      const error: Error & { code?: string } = new Error(result.error || "Failed to fetch usage");
      error.code = result.code;
      throw error;
    }
    return result;
  });
}

export function useUsage(): UseUsageResult | null {
  const { isSignedIn, isLoaded, user } = useAuth();
  const state = useSyncExternalStore(subscribeUsage, getUsageState);

  const accountId = isSignedIn ? (user?.id ?? null) : null;

  useEffect(() => {
    if (!isLoaded) return;
    setUsageAccount(accountId);
  }, [isLoaded, accountId]);

  useEffect(() => {
    if (!isLoaded || !accountId) return;

    void loadUsage(fetchUsageResponse);

    const handleUsageChanged = () => {
      void loadUsage(fetchUsageResponse, { force: true });
    };
    window.addEventListener("usage-changed", handleUsageChanged);
    return () => {
      window.removeEventListener("usage-changed", handleUsageChanged);
    };
  }, [isLoaded, accountId]);

  const refetch = useCallback(() => loadUsage(fetchUsageResponse, { force: true }), []);
  const retry = useCallback(() => retryUsage(fetchUsageResponse), []);

  if (!isSignedIn) return null;

  const data = state.status === "success" ? state.data : null;
  const wordsUsed = data?.wordsUsed ?? 0;
  const limit = data?.limit ?? 0;
  const isSubscribed = data?.isSubscribed ?? false;
  const isTrial = data?.isTrial ?? false;
  const hasPaidAccess = data ? data.isSubscribed || data.isTrial : null;
  const isOverLimit = Boolean(data) && !isSubscribed && limit > 0 && wordsUsed >= limit;
  const isApproachingLimit =
    Boolean(data) && !isSubscribed && limit > 0 && wordsUsed >= limit * 0.8 && !isOverLimit;

  return {
    status: state.status,
    isRefreshing: state.status === "success" && state.isRefreshing,
    isRetrying: state.status === "error" && state.isRetrying,
    error: state.status === "error" ? state.error : null,
    retry,
    refetch,
    hasPaidAccess,
    hasPaidAccessOptimistic: hasPaidAccess !== false,
    plan: data?.plan ?? "free",
    isPastDue: data ? isPastDueUsage(data) : false,
    wordsUsed,
    wordsRemaining: data?.wordsRemaining ?? 0,
    limit,
    isSubscribed,
    isPersonallySubscribed: data?.entitlementSources.personal ?? false,
    storeBilling: data ? storeBillingOf(data) : null,
    entitledWorkspaceIds: data?.entitlementSources.workspaceIds ?? [],
    isTrial,
    trialDaysLeft: data?.trialDaysLeft ?? null,
    currentPeriodEnd: data?.currentPeriodEnd ?? null,
    billingInterval: data?.billingInterval ?? null,
    isOverLimit,
    isApproachingLimit,
    resetAt: data?.resetAt ?? null,
  };
}
