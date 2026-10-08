'use strict';

/*
 * Opens the generated app in a headless browser and behaves like a user.
 *
 *  - Every app: loads the page and reports uncaught runtime errors
 *    (e.g. "bookmarks.map" on undefined) and failed API calls (HTTP 5xx).
 *  - Apps with an image file input: also uploads two generated PNGs,
 *    clicks the compare/verify/submit button, and reports whatever
 *    breaks, including the real response body and backend log tail.
 *
 * Needs (once):  npm install playwright && npx playwright install chromium
 * If Playwright or Chromium is missing the check is skipped, never failed.
 */

const zlib = require('zlib');

/* ---------- tiny PNG generator (no extra packages) ---------- */

let crcTable;

function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }

  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([len, body, crc]);
}

function makePng(width, height, pixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[y * stride + 1 + x * 3] = r;
      raw[y * stride + 2 + x * 3] = g;
      raw[y * stride + 3 + x * 3] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const bg = (y) => [235 - (y >> 3), 235, 225];
const bar = (x, y) => x > 60 && x < 340 && y > 60 && y < 90;
const patch = (x, y) => x > 200 && x < 260 && y > 150 && y < 200;

const ORIGINAL = makePng(400, 300, (x, y) => (bar(x, y) ? [20, 20, 20] : bg(y)));

const CANDIDATE = makePng(400, 300, (x, y) =>
  bar(x, y) ? [20, 20, 20] : patch(x, y) ? [200, 30, 30] : bg(y)
);

/* ---------- the check ---------- */

const firstLine = (error) => String(error?.message || error).split('\n')[0];

async function runBrowserE2E({ frontendPort, backendLogPath, readLogTail }) {
  let chromium;

  try {
    ({ chromium } = require('playwright'));
  } catch {
    return {
      issues: [],
      skipped:
        'playwright not installed (run: npm install playwright && npx playwright install chromium)',
    };
  }

  let browser;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    return {
      issues: [],
      skipped: `chromium unavailable (${firstLine(error)})`,
    };
  }

  const issues = [];

  try {
    const page = await browser.newPage();

    const consoleErrors = [];
    const badResponses = [];

    page.on('console', (message) => {
      const text = message.text();

      // React dev warnings and failed-resource noise are not crashes;
      // failed API calls are reported separately below.
      if (
        message.type() === 'error' &&
        !/^Warning:/i.test(text) &&
        !/Failed to load resource/i.test(text)
      ) {
        consoleErrors.push(text);
      }
    });

    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    page.on('response', async (response) => {
      if (response.status() >= 500 && response.url().includes('/api/')) {
        let body = '';

        try {
          body = (await response.text()).slice(0, 400);
        } catch {
          body = '';
        }

        badResponses.push(
          `${response.request().method()} ${new URL(response.url()).pathname} returned HTTP ${response.status()}: ${body}`
        );
      }
    });

    await page.goto(`http://127.0.0.1:${frontendPort}`, {
      waitUntil: 'load',
      timeout: 30000,
    });

    await page.waitForTimeout(1500);

    // Is this an image-upload app?
    const inputs = page.locator('input[type=file]');
    const inputCount = await inputs.count();

    let uploadFlow = inputCount > 0;

    if (uploadFlow) {
      const accept = (
        (await inputs.first().getAttribute('accept')) || ''
      ).toLowerCase();

      uploadFlow = !accept || /image|png|jpe?g|\*\/\*/.test(accept);
    }

    if (!uploadFlow) {
      // Not an upload app: page-load errors are still worth reporting.
      await page.waitForTimeout(1000);
    } else {
      const files = [
        { name: 'original.png', mimeType: 'image/png', buffer: ORIGINAL },
        { name: 'candidate.png', mimeType: 'image/png', buffer: CANDIDATE },
      ];

      if (inputCount === 1) {
        try {
          await inputs.first().setInputFiles(files);
        } catch {
          await inputs.first().setInputFiles(files[0]);
        }
      } else {
        for (let i = 0; i < inputCount; i++) {
          await inputs.nth(i).setInputFiles(files[Math.min(i, 1)]);
        }
      }

      const button = page
        .getByRole('button', {
          name: /compare|verify|check|analy[sz]e|submit|upload/i,
        })
        .first();

      if (!(await button.count())) {
        issues.push(
          'Browser E2E: no compare/verify/submit button found on the page after selecting two images.'
        );
      } else {
        const posted = page
          .waitForResponse(
            (response) =>
              response.url().includes('/api/') &&
              response.request().method() === 'POST',
            { timeout: 90000 }
          )
          .catch(() => null);

        await button.click({ timeout: 15000 });

        if (!(await posted)) {
          issues.push(
            'Browser E2E: clicking the button never sent a POST to the API within 90s.'
          );
        }

        await page.waitForTimeout(2000);

        if (badResponses.length === 0) {
          const text = await page.locator('body').innerText();

          const shown = text.match(
            /[^\n]*(error|failed|unexpected|something went wrong)[^\n]*/i
          );

          if (shown) {
            issues.push(
              `Browser E2E: the page shows an error after upload: "${shown[0].trim().slice(0, 200)}"`
            );
          }
        }
      }
    }

    for (const response of badResponses) {
      issues.push(`Browser E2E: ${response}`);
    }

    for (const error of consoleErrors.slice(0, 3)) {
      issues.push(`Browser E2E: runtime error in the page: ${error.slice(0, 300)}`);
    }
  } catch (error) {
    issues.push(
      `Browser E2E could not load or exercise the page: ${firstLine(error)}`
    );
  } finally {
    await browser.close();
  }

  if (issues.length > 0 && backendLogPath && readLogTail) {
    try {
      issues[0] += `\n\nBackend log tail:\n${readLogTail(backendLogPath, 3000)}`;
    } catch {
      // The log is a nicety; never let reading it break the check.
    }
  }

  return { issues };
}

module.exports = { runBrowserE2E };