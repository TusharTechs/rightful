/**
 * `npm run dev:api:fake`: the API with in-memory Payouts and no PayPal app, on any OS (no shell
 * syntax for environment variables). Values already set in the environment win.
 */

process.env.PAYPAL_MODE ??= "fake";
process.env.ADMIN_TOKEN ??= "dev-admin-token";

const { startServer } = await import("../src/api/main.ts");
const server = await startServer(process.env, { clock: true });
console.log(`Rightful API (fake PayPal) listening on ${server.url}; admin token ${process.env.ADMIN_TOKEN}`);
