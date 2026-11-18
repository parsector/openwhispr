import { useCallback, useEffect, useRef, useState } from 'react';
import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { Text } from '@/components/ui/Text';

/** Compatibility for saved onboarding progress after removing attribution. */
export function TrackingPermissionStep({ onComplete }: { onComplete?: () => Promise<void> } = {}) {
  const { goNext } = useOnboardingStep('tracking-permission');
  const started = useRef(false);
  const [error, setError] = useState(false);
  const advance = useCallback(async () => {
    try {
      setError(false);
      await (onComplete ?? goNext)();
    } catch {
      setError(true);
    }
  }, [goNext, onComplete]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void advance();
  }, [advance]);
  if (!error) return null;
  return <OnboardingShell title="" ctaLabel="Continue" onCta={advance}>
    <Text accessibilityRole="alert">Could not save progress. Try again.</Text>
  </OnboardingShell>;
}
