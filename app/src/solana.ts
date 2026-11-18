import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "@infermesh/sdk";

export const DEVNET = "https://api.devnet.solana.com";

/** Derive the marketplace PDA offchain for display / explorer links. */
export async function marketplacePda(): Promise<string> {
  const programId = new PublicKey(PROGRAM_ID);
  const [pda] = await PublicKey.findProgramAddress([new TextEncoder().encode("marketplace")], programId);
  return pda.toBase58();
}

export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}
