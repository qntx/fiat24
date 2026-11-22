// The shared freeze helper: generated in the abi leaf so every layer may
// deep-freeze its exported tables without importing above itself.
export { deepFreeze as freeze } from "../abi/freeze.ts";
