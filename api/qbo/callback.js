export default function handler(req, res) {
  const { code, realmId, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`<!doctype html><html lang="en"><head>
      <meta charset="utf-8">
      <title>OAuth Failed | Journal MCP</title>
      <style>body{font-family:Arial,sans-serif;max-width:700px;margin:60px auto;padding:0 20px;color:#222}
      h1{color:#c00}.box{background:#fff0f0;border:1px solid #f99;border-radius:6px;padding:16px;margin-top:16px}</style>
    </head><body>
      <h1>QuickBooks OAuth failed</h1>
      <div class="box"><strong>${error}</strong><br>${error_description || ""}</div>
    </body></html>`);
  }

  // Reconstruct the full callback URL so it can be pasted straight into the auth script
  const fullUrl = `https://${req.headers.host}${req.url}`;

  return res.status(200).send(`<!doctype html><html lang="en"><head>
    <meta charset="utf-8">
    <title>OAuth Success | Journal MCP</title>
    <style>
      body{font-family:Arial,sans-serif;max-width:700px;margin:60px auto;padding:0 20px;color:#222}
      h1{color:#1a7a3c}
      .label{font-size:.85em;color:#555;margin-top:16px;margin-bottom:4px}
      .box{background:#f4f9f4;border:1px solid #b2d8b2;border-radius:6px;padding:14px;
           font-family:monospace;font-size:.95em;word-break:break-all;cursor:pointer}
      .box:hover{background:#e8f5e8}
      .copy-btn{margin-top:8px;padding:6px 14px;background:#1a7a3c;color:#fff;
                border:none;border-radius:4px;cursor:pointer;font-size:.9em}
      .copy-btn:hover{background:#155c2e}
      .note{font-size:.85em;color:#555;margin-top:24px}
    </style>
  </head><body>
    <h1>✓ QuickBooks authorisation received</h1>
    <p>Copy the full URL below and paste it into your terminal when prompted by <code>node dist/auth.js</code>.</p>

    <div class="label">Full callback URL (click to copy)</div>
    <div class="box" id="url" onclick="copyUrl()">${fullUrl}</div>
    <button class="copy-btn" onclick="copyUrl()">Copy URL</button>

    <div class="label" style="margin-top:24px">Individual values</div>
    <table style="border-collapse:collapse;width:100%">
      <tr><td style="padding:6px 0;color:#555;width:120px">code</td>
          <td style="font-family:monospace;word-break:break-all">${code || ""}</td></tr>
      <tr><td style="padding:6px 0;color:#555">realmId</td>
          <td style="font-family:monospace">${realmId || ""}</td></tr>
      <tr><td style="padding:6px 0;color:#555">state</td>
          <td style="font-family:monospace">${state || ""}</td></tr>
    </table>

    <p class="note">You can close this window once you have copied the URL.</p>

    <script>
      function copyUrl() {
        navigator.clipboard.writeText(${JSON.stringify(fullUrl)}).then(() => {
          document.querySelector('.copy-btn').textContent = 'Copied!';
          setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy URL', 2000);
        });
      }
    </script>
  </body></html>`);
}
