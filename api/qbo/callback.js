export default function handler(req, res) {
  const { code, realmId, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(`
      <h1>QuickBooks OAuth failed</h1>
      <p>${error}</p>
      <p>${error_description || ""}</p>
    `);
  }

  return res.status(200).send(`
    <h1>QuickBooks OAuth callback received</h1>
    <p><strong>code:</strong> ${code || ""}</p>
    <p><strong>realmId:</strong> ${realmId || ""}</p>
    <p><strong>state:</strong> ${state || ""}</p>
  `);
}
