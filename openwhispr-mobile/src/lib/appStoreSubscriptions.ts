import { Linking, Platform } from 'react-native';

// No attribution SDK is loaded to discover the storefront. The account screen
// already handles an unavailable country with its standard subscription link.
export async function getAppStorefrontCountryCode(): Promise<string | null> {
  return null;
}

export async function showAppStoreManageSubscriptions(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    await Linking.openURL('https://apps.apple.com/account/subscriptions');
    return true;
  } catch {
    return false;
  }
}
