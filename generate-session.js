/**
 * Voer dit script LOKAAL uit (niet in Docker) om sessiebestanden te genereren.
 * Het opent een zichtbare browser zodat je handmatig kunt inloggen.
 *
 * Gebruik:
 *   node generate-session.js instagram
 *   node generate-session.js tiktok
 *
 * Na het inloggen: druk Enter in de terminal.
 * Het script slaat het sessiebestand op als instagram.json of tiktok.json.
 * Kopieer dat bestand naar de server (zie instructies onderaan).
 */

const { chromium } = require('playwright');
const readline      = require('readline');
const fs            = require('fs');

const platform = process.argv[2];
if (!platform || !['instagram', 'tiktok'].includes(platform)) {
  console.error('Gebruik: node generate-session.js instagram|tiktok');
  process.exit(1);
}

const urls = {
  instagram: 'https://www.instagram.com/accounts/login/',
  tiktok:    'https://www.tiktok.com/login',
};

(async () => {
  console.log(`\nBrowser openen voor ${platform}...`);
  const browser = await chromium.launch({ headless: false });
  const ctx     = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    viewport:   { width: 1280, height: 900 },
    locale:     'nl-NL',
    timezoneId: 'Europe/Amsterdam',
  });

  const page = await ctx.newPage();
  await page.goto(urls[platform]);

  console.log(`\n➡  Log in op ${platform} in het browservenster.`);
  console.log('   Druk daarna op Enter in dit terminalvenster...\n');

  await new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => { rl.close(); resolve(); });
  });

  const outFile = `${platform}.json`;
  await ctx.storageState({ path: outFile });
  await browser.close();

  console.log(`\n✅ Sessie opgeslagen als: ${outFile}`);
  console.log('\nKopieer het bestand naar de server met:\n');
  console.log(`  scp ${outFile} devteam@72.62.49.102:/tmp/`);
  console.log('\nEn kopieer het daarna naar het Docker-volume:\n');
  console.log(`  # Zoek de volume-naam op:`);
  console.log(`  docker volume ls | grep sessions`);
  console.log(`  # Kopieer naar het volume:`);
  console.log(`  docker run --rm -v <volume-naam>:/sessions -v /tmp:/src alpine cp /src/${outFile} /sessions/${outFile}`);
  console.log('\nDan de container herstarten in Coolify (Restart knop).\n');
})();
