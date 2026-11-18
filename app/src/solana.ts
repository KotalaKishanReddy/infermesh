import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "@infermesh/sdk";

export const DEVNET = "https://api.devnet.solana.com";

export interface WalletState {
  publicKey: string;
  balanceSol: number;
  signature: string | null;
}

let keypair: Keypair | null = null;

export async function connectDevnet(): Promise<WalletState> {
  const connection = new Connection(DEVNET, "confirmed");
  if (!keypair) keypair = Keypair.generate();
  const pubkey = keypair.publicKey;
  let balance = await connection.getBalance(pubkey);
  let signature: string | null = null;
  if (balance === 0) {
    signature = await connection.requestAirdrop(pubkey, LAMPORTS_PER_SOL);
    // Wait for confirmation (best-effort; demo panel only).
    await connection.confirmTransaction(signature, "confirmed");
    balance = await connection.getBalance(pubkey);
  }
  return { publicKey: pubkey.toBase58(), balanceSol: balance / LAMPORTS_PER_SOL, signature };
}

/** Derive the marketplace PDA offchain for display / explorer links. */
export async function marketplacePda(): Promise<string> {
  const programId = new PublicKey(PROGRAM_ID);
  const [pda] = await PublicKey.findProgramAddress([new TextEncoder().encode("marketplace")], programId);
  return pda.toBase58();
}

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
