// Manual check of the unofficial feed. Never run by CI.
const queries = process.argv.slice(2);
const tags = queries.length ? queries : ["", "pastel", "vintage", "retro", "neon", "light", "dark", "warm", "cold", "nature", "earth", "sunset", "space", "neon-dark", "pastel-warm", "neon-space"];
for (const query of tags) {
  try {
    const response = await fetch("https://colorhunt.co/php/feed.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", Accept: "application/json, text/plain, */*" },
      body: new URLSearchParams({ step: "0", sort: "random", tags: query }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Feed was not a list");
    const codes = new Set(rows.map(row => row?.code).filter(code => typeof code === "string" && /^[a-f\d]{24}$/i.test(code)).map(code => code.toLowerCase()));
    console.log(`${query || "All"}: ${rows.length} rows, ${codes.size} usable palettes`);
  } catch (error) {
    console.error(`${query || "All"}: ${error.message}`);
    process.exitCode = 1;
  }
}
