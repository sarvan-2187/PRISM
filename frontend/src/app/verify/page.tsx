'use client';
import { useSearchParams } from 'next/navigation';
import StepUpChallenge from '@/components/StepUpChallenge';
import { useRouter } from 'next/navigation';

/**
 * Step-Up Verification Page
 * Shown when Risk Engine returns STEP_UP_REQUIRED.
 */
export default function VerifyPage() {
  const params = useSearchParams();
  const router = useRouter();
  const transactionId = params.get('id') ?? '';
  const challengeText = params.get('challenge') ?? '';
  const stepUpToken = params.get('token') ?? '';

  const handleComplete = (approved: boolean) => {
    // TODO: redirect to /status?id=transactionId&status=APPROVED or BLOCKED
    router.push(`/status?id=${transactionId}&status=${approved ? 'APPROVED' : 'BLOCKED'}`);
  };

  return (
    <div className="verify-page">
      <StepUpChallenge
        transactionId={transactionId}
        challengeText={challengeText}
        stepUpToken={stepUpToken}
        onComplete={handleComplete}
      />
    </div>
  );
}
