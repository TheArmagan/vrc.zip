/**
 * The page served when someone points a browser straight at the forward proxy port.
 *
 * It exists because the proxy has a setup step no other port has: a certificate the user must
 * install by hand. A port that answered "this is a proxy, not a website" and stopped there would be
 * technically correct and would leave the user with nothing to do next, so this hands them the
 * download and the exact command for their platform instead.
 *
 * Deliberately a plain string rather than anything that reads a file at request time: it is served
 * from a raw socket handler with no framework underneath it, and it must never be able to fail.
 */

export interface HelpPageOptions {
  readonly proxyUrl: string;
  readonly caCertPath: string;
  readonly hosts: readonly string[];
  readonly mirrorPort: number;
}

export function helpPage({ proxyUrl, caCertPath, hosts, mirrorPort }: HelpPageOptions): string {
  const list = hosts.map((host) => `<li><code>${escapeHtml(host)}</code></li>`).join("");
  const path = escapeHtml(caCertPath);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vrc.zip proxy setup</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .tag { display: inline-block; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; border: 1px solid currentColor; border-radius: .25rem; padding: 0 .35rem; opacity: .7; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
  pre { background: color-mix(in srgb, currentColor 8%, transparent); padding: .7rem .9rem; border-radius: .4rem; overflow-x: auto; }
  ol { padding-left: 1.2rem; }
  li { margin: .4rem 0; }
  .warn { border-left: 3px solid currentColor; padding-left: .9rem; opacity: .85; }
</style>
</head>
<body>
<p><span class="tag">Unofficial</span></p>
<h1>vrc.zip forward proxy</h1>
<p>This port is an HTTP proxy, not a website. Point a proxy-aware app at
<code>${escapeHtml(proxyUrl)}</code> and its VRChat API calls are served by the local mirror on
port ${String(mirrorPort)} instead of going to VRChat.</p>

<h2>1. Install the certificate</h2>
<p>VRChat's API is HTTPS, so the proxy has to present a certificate for it. It signs one with a CA
that lives only on this machine, and your app has to trust that CA first.</p>
<p><a href="/vrczip-ca.crt" download>Download vrczip-ca.crt</a>, or take it from
<code>${path}</code>.</p>

<p><strong>Windows</strong> (this is what Chromium, and therefore VRCX, reads):</p>
<pre>certutil -addstore -user Root "${path}"</pre>

<p><strong>Linux</strong>, system trust store:</p>
<pre>sudo cp "${path}" /usr/local/share/ca-certificates/vrczip.crt
sudo update-ca-certificates</pre>

<p><strong>Linux</strong>, Chromium's own NSS database:</p>
<pre>certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n vrc.zip -i "${path}"</pre>

<h2>2. Point the app at the proxy</h2>
<p>VRCX and anything else built on Chromium or Electron:</p>
<pre>VRCX.exe --proxy-server=${escapeHtml(proxyUrl)}</pre>
<p>Most other tooling reads the environment:</p>
<pre>HTTP_PROXY=${escapeHtml(proxyUrl)} HTTPS_PROXY=${escapeHtml(proxyUrl)}</pre>

<h2>What gets intercepted</h2>
<p>Only these hosts are decrypted and routed to the mirror:</p>
<ul>${list}</ul>
<p>Everything else is tunnelled straight through to the real server and is never decrypted.</p>

<h2 class="warn">Before you install it</h2>
<p class="warn">That CA can vouch for any site, not just VRChat, for as long as it is installed. Its
private key sits next to the certificate above, readable only by your user account. Remove it when
you are done, and treat a copy leaving this machine as a compromise of every site you browse.</p>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface BannerOptions {
  readonly proxyUrl: string;
  readonly caCertPath: string;
  readonly caIsNew: boolean;
  readonly hosts: readonly string[];
}

/**
 * The startup lines for the forward proxy.
 *
 * Returned rather than logged, so the wording is assertable without binding a port, and so the
 * "install the CA" half is printed loudly only on the run that actually minted one — a setup
 * instruction repeated every boot is one nobody reads by the third time.
 *
 * **The URL is no longer one of these lines.** It belongs with the other addresses in the startup
 * summary, and announcing it from here put it above them, in a different format, before the block
 * that lists everything else. What is left is the part that is genuinely this module's: an
 * instruction, on the one run where it applies.
 */
export function forwardProxyBanner({ proxyUrl, caCertPath, caIsNew }: BannerOptions): string[] {
  if (!caIsNew) return [];
  /*
   * The page first, the command second.
   *
   * Installing a certificate is the one setup step here that a user can get *wrong* in a way that
   * matters, and the page at the proxy explains what the certificate is and why a local one is
   * needed before it asks anyone to trust it. A `certutil` line on its own is a command to paste
   * without understanding, which is exactly the habit a tool handling someone's credentials should
   * not be teaching.
   */
  return [
    "The forward proxy needs its certificate installed before HTTPS through it will work.",
    `Open ${proxyUrl}/ and follow the steps there — it explains what it is installing and why.`,
    `The certificate itself is at ${caCertPath}`,
  ];
}
