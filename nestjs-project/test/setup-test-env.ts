/**
 * Test-environment shim, loaded by `setupFiles` after `dotenv/config`.
 *
 * `S3_PUBLIC_ENDPOINT` is the address an *external* client resolves — for local
 * development that is `http://localhost:9000`. Every test in this project runs
 * *inside* the API container, where `localhost` is the container itself, so a
 * test acting as the upload client cannot fetch a URL signed for that host. A
 * SigV4 signature binds the Host header, so the URL cannot simply be rewritten
 * after signing either.
 *
 * `S3_PUBLIC_ENDPOINT_TEST` therefore names an address that is reachable from
 * inside the Compose network and still distinct from `S3_ENDPOINT`'s role, so
 * the public/internal client split (TD-10) stays exercised end to end.
 */
if (process.env.S3_PUBLIC_ENDPOINT_TEST) {
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_PUBLIC_ENDPOINT_TEST;
}
