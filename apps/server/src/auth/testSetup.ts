/**
 * The test-suite auth bypass (registered as vitest's `setupFiles`).
 *
 * Hundreds of specs drive a router directly (`vaults.request("/")`), which
 * never passes through `authenticate` and therefore has no principal. The
 * middleware's bypass is the supported way for those to keep their subject —
 * but it is gated on BOTH `AUTH_TEST_BYPASS=1` and `NODE_ENV=test`, and this
 * file only sets it under the second condition. A production container never
 * loads this module.
 *
 * Specs that exercise the real credential path (`auth`, `admin`, `scope`)
 * delete the variable in their own `beforeEach` and restore it after, so the
 * bypass here is a default, not a cage.
 */
if (process.env.NODE_ENV === "test" && process.env.AUTH_TEST_BYPASS === undefined) {
  process.env.AUTH_TEST_BYPASS = "1";
}
