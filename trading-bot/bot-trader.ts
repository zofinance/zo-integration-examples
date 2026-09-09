import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ZO_API_ENDPOINT } from './connection';

interface BotTraderStatusData {
    address: string;
    verified: boolean;
    verifiedAt: string | null;
}

interface ChallengeData {
    address: string;
    nonce: string;
    message: string;
    expiresAt: string;
}

interface ChallengeResponse {
    success: boolean;
    alreadyVerified?: boolean;
    data?: ChallengeData | { address: string; verifiedAt: string };
    error?: string;
    message?: string;
}

interface VerifyResponse {
    success: boolean;
    message?: string;
    data?: { address: string; verifiedAt: string };
    error?: string;
}

interface StatusResponse {
    success: boolean;
    data?: BotTraderStatusData;
    error?: string;
    message?: string;
}

async function apiJson<T>(
    path: string,
    init?: RequestInit,
): Promise<T> {
    const res = await fetch(`${ZO_API_ENDPOINT.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
    const body = (await res.json()) as T & {
        success?: boolean;
        error?: string;
        message?: string;
    };
    if (!res.ok || body.success === false) {
        throw new Error(
            body.error ||
                body.message ||
                `bot-traders request failed (${res.status}) ${path}`,
        );
    }
    return body;
}

/** GET /bot-traders/:address */
export async function getBotTraderStatus(
    address: string,
): Promise<BotTraderStatusData> {
    const body = await apiJson<StatusResponse>(
        `/bot-traders/${encodeURIComponent(address)}`,
    );
    if (!body.data) {
        throw new Error('bot-traders status response missing data');
    }
    return body.data;
}

/**
 * Challenge → personal-message sign → verify (or skip if already verified).
 * Challenge expires in 10 minutes; signs the exact `message` from the API.
 */
export async function ensureBotTraderVerified(
    keypair: Ed25519Keypair,
): Promise<{ address: string; verifiedAt?: string | null }> {
    const address = keypair.getPublicKey().toSuiAddress();

    try {
        const status = await getBotTraderStatus(address);
        if (status.verified) {
            console.log(
                `Bot trader already verified: ${address}` +
                    (status.verifiedAt ? ` (at ${status.verifiedAt})` : ''),
            );
            return { address, verifiedAt: status.verifiedAt };
        }
    } catch {
        // Status endpoint may 404 for unknown addresses; continue to challenge.
    }

    console.log(`Requesting bot-trader challenge for ${address}...`);
    const challenge = await apiJson<ChallengeResponse>('/bot-traders/challenge', {
        method: 'POST',
        body: JSON.stringify({ address }),
    });

    if (challenge.alreadyVerified) {
        const verifiedAt =
            challenge.data && 'verifiedAt' in challenge.data
                ? challenge.data.verifiedAt
                : null;
        console.log(`Bot trader already verified: ${address}`);
        return { address, verifiedAt };
    }

    const data = challenge.data;
    if (!data || !('message' in data) || !data.message) {
        throw new Error('bot-traders challenge missing message to sign');
    }

    // Sign the exact challenge message string (do not rebuild it).
    const messageBytes = new TextEncoder().encode(data.message);
    const { signature } = await keypair.signPersonalMessage(messageBytes);

    console.log('Submitting bot-trader verification signature...');
    const verified = await apiJson<VerifyResponse>('/bot-traders/verify', {
        method: 'POST',
        body: JSON.stringify({ address, signature }),
    });

    const verifiedAt = verified.data?.verifiedAt ?? null;
    console.log(
        `Verified as bot trader: ${address}` +
            (verifiedAt ? ` (at ${verifiedAt})` : ''),
    );
    return { address, verifiedAt };
}
