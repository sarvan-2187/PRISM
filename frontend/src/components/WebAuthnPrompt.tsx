'use client';

interface WebAuthnPromptProps {
  onAuthenticate: () => Promise<void>;
  isLoading?: boolean;
}

/**
 * WebAuthn Passkey Prompt Component
 * Triggers the device's native passkey UI.
 * The WebAuthn challenge MUST be the intentHash (set before calling this component).
 */
export default function WebAuthnPrompt({ onAuthenticate, isLoading }: WebAuthnPromptProps) {
  return (
    <div className="webauthn-prompt">
      <p>Confirm this payment with your device passkey.</p>
      {/* TODO: Display transaction summary (amount, recipient) from context/props */}
      <button onClick={onAuthenticate} disabled={isLoading}>
        {isLoading ? 'Verifying...' : 'Authenticate with Passkey'}
      </button>
    </div>
  );
}
