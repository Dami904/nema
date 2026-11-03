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
  contractWasmSha256: "2f7e8f57f802713f99a449f23e86bb681cc9bdbe2a1316544eb6490cf1aa37c1",
  enclaveWasmSha256: "bb974b6a3188d4c07a37396f8fcbfd6f53be52b003bc849544c4f31a16766718",
  enclaveProject: "nema-dev.testnet/nema-aggregator",
};

/** OutLayer's minimum deposit for one enclave call, on top of the read price. */
export const ENCLAVE_FEE_YOCTO = 10n ** 22n;
/** Kept by the contract on every read and audit, for the record it stores. */
export const STORAGE_DEPOSIT_YOCTO = 2n * 10n ** 22n;
/** What a read or an audit attaches on top of any read price. */
export const READ_EXTRA_YOCTO = ENCLAVE_FEE_YOCTO + STORAGE_DEPOSIT_YOCTO;

export const POLL_MS = 15_000;
