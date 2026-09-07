'use client';
import { useState } from 'react';

interface StepUpChallengeProps {
  transactionId: string;
  challengeText: string;
  stepUpToken: string;
  onComplete: (approved: boolean) => void;
}

/**
 * Step-Up Challenge Component
 * Shown when Risk Engine returns STEP_UP_REQUIRED.
 * User must type back confirmation of what they're approving.
 */
export default function StepUpChallenge({
  transactionId,
  challengeText,
  stepUpToken,
  onComplete,
}: StepUpChallengeProps) {
  const [confirmation, setConfirmation] = useState('');

  const handleSubmit = async () => {
    // TODO: Call POST /api/v1/verify/step-up with { transactionId, userConfirmation: confirmation, stepUpToken }
    // TODO: onComplete(result.approved)
  };

  return (
    <div className="step-up-challenge">
      <h2>Additional Verification Required</h2>
      <p>Please type the following to confirm:</p>
      <blockquote>{challengeText}</blockquote>
      <input
        type="text"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        placeholder="Type confirmation here..."
      />
      <button onClick={handleSubmit}>Confirm</button>
    </div>
  );
}
