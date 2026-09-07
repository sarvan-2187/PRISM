'use client';
import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { webauthnClient } from '@/lib/webauthn-client';

/**
 * Payment Initiation Screen
 */
export default function PayPage() {
    const [amount, setAmount] = useState('');
    
    const handlePayment = async () => {
        // 1. Initiate Payment -> get intentHash (challenge)
        // const intent = await apiClient.initiatePayment({ recipientId: '123', amount: Number(amount) });
        
        // 2. Prompt Passkey / WebAuthn
        // const authOptions = ... // fetch from backend using intentHash
        // const authResponse = await webauthnClient.authenticate(authOptions);
        
        // 3. Authorize via API
        // const result = await apiClient.authorizePayment(intent.transactionId, authResponse);
        
        // 4. Handle Result (redirect to /status or /verify based on Risk Engine)
    };

    return (
        <div className="p-8 max-w-md mx-auto">
            <h1 className="text-2xl font-bold mb-4">Send Payment</h1>
            {/* TODO: Implement form and loading states */}
            <input 
                type="number" 
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount" 
                className="border p-2 w-full mb-4"
            />
            <button onClick={handlePayment} className="bg-blue-600 text-white p-2 w-full rounded">
                Pay with Passkey
            </button>
        </div>
    );
}
