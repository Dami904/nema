// `import.meta.env` is undefined when the test script imports this under plain Node.
const env: Record<string, unknown> = import.meta.env ?? {};

export const CONFIG = {
  network: (env.VITE_NEAR_NETWORK as string | undefined) ?? "testnet",
  rpc: (env.VITE_NEAR_RPC as string | undefined) ?? "https://rpc.testnet.fastnear.com",
  contract: (env.VITE_NEMA_CONTRACT as string | undefined) ?? "nema-dev.testnet",
  explorerTx: (env.VITE_EXPLORER_TX as string | undefined) ?? "https://testnet.nearblocks.io/txns/",
  explorerAccount: (env.VITE_EXPLORER_ACCOUNT as string | undefined) ?? "https://testnet.nearblocks.io/address/",
};

/** The public repository, linked from the footer once it is set. */
export const REPO_URL = (env.VITE_REPO_URL as string | undefined) ?? "";

/** Builds we expect on chain, so the Docs page can compare them. */
export const BUILDS = {
  contractWasmSha256: "05e0b58ede2fbb1899d9673b980e6166a82a9d7c380298d876c37af4939108f8",
  enclaveWasmSha256: "3ed58517795dc12a8f749b4ce92c747a47cbdb7ded3d383465d042060fe750d6",
  enclaveProject: "nema-dev.testnet/nema-aggregator",
};

/** Two hosts serve the same enclave bytes; the OutLayer project loads one (`pnpm live:enclave-source`). */
export const ENCLAVE_URLS = {
  fastfs: `https://test.fastfs.io/nema-dev.testnet/outlayer.testnet/${BUILDS.enclaveWasmSha256}.wasm`,
  github: "https://github.com/Dami904/nema/releases/download/enclave-v2/nema-aggregator.wasm",
};

/** OutLayer's minimum deposit for one enclave call, on top of the read price. */
export const ENCLAVE_FEE_YOCTO = 10n ** 22n;
/** Kept by the contract on every read and audit, for the record it stores. */
export const STORAGE_DEPOSIT_YOCTO = 2n * 10n ** 22n;
/** What a read or an audit attaches on top of any read price. */
export const READ_EXTRA_YOCTO = ENCLAVE_FEE_YOCTO + STORAGE_DEPOSIT_YOCTO;
/** Attached to a submission: covers the largest mark's storage; the rest comes back. */
export const SUBMIT_DEPOSIT_YOCTO = 3n * 10n ** 22n;

export const POLL_MS = 15_000;
/** How long the contract waits on the enclave before anyone may settle a call (STALE_AFTER_NS). */
export const STALE_AFTER_MS = 30 * 60_000;
