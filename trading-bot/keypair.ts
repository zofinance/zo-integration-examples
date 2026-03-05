import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import * as dotenv from 'dotenv';

dotenv.config();

export function getKeypair(): Ed25519Keypair {
    const privateKeyBech32 = process.env.PRIVATE_KEY;

    if (!privateKeyBech32) {
        throw new Error(
            'not found PRIVATE_KEY, please set private key in .env file',
        );
    }

    try {
        const { secretKey } = decodeSuiPrivateKey(privateKeyBech32);
        return Ed25519Keypair.fromSecretKey(secretKey);
    } catch (error) {
        throw new Error(`create keypair failed: ${error}`);
    }
}
