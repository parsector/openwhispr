import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed, isConnectorsBlockedByOrg } from "../stores/policyRules";

export interface ConnectorAccess {
  /** Compatibility field for callers; connectors have no plan requirement. */
  isPaid: boolean;
  blockedByOrg: boolean;
  connectorsAllowed: boolean;
}

export function useConnectorAccess(): ConnectorAccess {
  return {
    isPaid: true,
    blockedByOrg: usePolicyStore(isConnectorsBlockedByOrg),
    connectorsAllowed: usePolicyStore(isConnectorsAllowed),
  };
}
