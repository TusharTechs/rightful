/**
 * The claimant's server-rendered pages (sign-in result, claim form, "is this your claim?", outcomes),
 * in the web app's look. Mobile first, no JavaScript needed except the device hash on the form,
 * labelled fields, visible focus, and results announced to screen readers.
 */

export function escape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const CSS = `
:root{--paper:#f6f4ee;--card:#fff;--ink:#121212;--muted:#5e5e5a;--line:#e2ded3;--accent:#ff4d2e;--good:#0b7a43;--good-bg:#e6f4ec;--bad:#b3261e;--bad-bg:#fbeae8;--paypal:#ffc439;--paypal-ink:#111a3d;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#111110;--card:#1b1b19;--ink:#f2f0ea;--muted:#a3a29b;--line:#2e2d29;--good:#5ad19a;--good-bg:#13291f;--bad:#ff8a80;--bad-bg:#2d1614;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:34rem;margin:0 auto;padding:20px 18px 48px}
.top{display:flex;align-items:center;gap:10px;font-weight:700;margin:4px 0 22px;text-decoration:none;color:inherit}
.mark{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--ink);color:var(--accent)}
h1{font-size:1.6rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 10px}
p{margin:0 0 12px}
.muted{color:var(--muted)}.small{font-size:.88rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
.badge{display:inline-flex;gap:6px;align-items:center;padding:4px 10px;border-radius:999px;font-size:.85rem;font-weight:700}
.badge.good{background:var(--good-bg);color:var(--good)}.badge.warn{background:var(--bad-bg);color:var(--bad)}
.result{border-left:4px solid var(--good)}.result.bad{border-left-color:var(--bad)}
label{display:block;font-weight:600;margin:16px 0 6px}
.hint{display:block;font-weight:400;color:var(--muted);font-size:.88rem;margin-top:2px}
input,textarea{width:100%;font:inherit;padding:12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
textarea{min-height:8rem;resize:vertical}
input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:14px 24px;min-height:48px;width:100%;margin-top:20px;cursor:pointer;background:var(--paypal);color:var(--paypal-ink)}
.link-button{display:block;text-align:center;text-decoration:none;font-weight:700;border-radius:999px;padding:13px 24px;margin-top:12px;border:1.5px solid var(--ink);color:var(--ink)}
dl{margin:0}dt{font-weight:600;margin-top:12px}dd{margin:2px 0 0;white-space:pre-wrap}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;word-break:break-all}
.steps{margin:8px 0 0;padding-left:20px}.steps li{margin:4px 0}
footer{color:var(--muted);font-size:.8rem;margin-top:32px}
`;

/** The page frame. `webBase` links the wordmark back to the web app. */
export function shell(title: string, body: string, webBase?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Rightful</title><style>${CSS}</style></head>
<body><main>
<a class="top" href="${escape(webBase ?? "/")}"><span class="mark" aria-hidden="true">R</span>Rightful</a>
${body}
<footer>PayPal sandbox only. No real money moves.</footer>
</main></body></html>`;
}

/** An outcome: what happened, in a card the screen reader announces, and where to go next. */
export function outcomePage(options: { title: string; message: string; ok: boolean; claimId?: string; statusUrl?: string; webBase?: string }): string {
  const next = options.statusUrl
    ? `<a class="link-button" href="${escape(options.statusUrl)}">Follow your claim</a><p class="muted small" style="margin-top:10px">Keep this link: it shows where your claim stands, and your payout receipt once it is paid.</p>`
    : "";
  return shell(
    options.title,
    `<section class="card result${options.ok ? "" : " bad"}" role="status" aria-live="polite">
<h1>${escape(options.title)}</h1><p>${escape(options.message)}</p>
${options.claimId ? `<p class="muted small">Claim <code>${escape(options.claimId)}</code></p>` : ""}
</section>${next}`,
    options.webBase,
  );
}
