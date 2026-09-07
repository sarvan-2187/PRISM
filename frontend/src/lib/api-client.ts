/**
 * Typed API Client for the PRISM backend.
 * All methods map 1:1 to backend routes in /api/v1.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const apiClient = {

  // ── Identity ──────────────────────────────────────────────

  async getRegistrationOptions(userId: string, email: string): Promise<any> {
    return request('/auth/register/options', {
      method: 'POST',
      body: JSON.stringify({ userId, email }),
    });
  },

  async submitRegistration(userId: string, response: any): Promise<void> {
    return request('/auth/register/verify', {
      method: 'POST',
      body: JSON.stringify({ userId, response }),
    });
  },

  async getAuthenticationOptions(userId: string, intentHash: string): Promise<any> {
    return request('/auth/login/options', {
      method: 'POST',
      body: JSON.stringify({ userId, intentHash }),
    });
  },

  async submitAuthentication(userId: string, response: any, transactionId: string): Promise<any> {
    return request('/auth/login/verify', {
      method: 'POST',
      body: JSON.stringify({ userId, response, transactionId }),
    });
  },

  // ── Payment ───────────────────────────────────────────────

  async initiatePayment(data: {
    userId: string;
    recipientId: string;
    amount: number;
    currency?: string;
  }): Promise<{ transactionId: string; nonce: string; intentHash: string; expiresAt: string }> {
    return request('/payment/initiate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async authorizePayment(transactionId: string, webauthnResponse: any): Promise<{
    status: 'APPROVED' | 'BLOCKED' | 'STEP_UP_REQUIRED';
    stepUpToken?: string;
    challengeText?: string;
  }> {
    return request('/payment/authorize', {
      method: 'POST',
      body: JSON.stringify({ transactionId, webauthnResponse }),
    });
  },

  // ── QR ────────────────────────────────────────────────────

  async generateQR(transactionId: string): Promise<string> {
    const data = await request<{ payload: string }>(`/qr/generate?transactionId=${transactionId}`);
    return data.payload;
  },

  // ── Step-Up ───────────────────────────────────────────────

  async submitStepUp(data: {
    transactionId: string;
    userConfirmation: string;
    stepUpToken: string;
  }): Promise<{ approved: boolean }> {
    return request('/verify/step-up', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // ── Status ────────────────────────────────────────────────

  async getTransactionStatus(transactionId: string): Promise<{
    status: string;
    riskScore?: number;
  }> {
    return request(`/transactions/${transactionId}`);
  },
};
