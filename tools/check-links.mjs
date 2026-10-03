import fs from 'node:fs/promises';
import path from 'node:path';

// GET checks preserve redirect destinations. HTTP success alone does not validate
// JavaScript routes, authenticated content, or the relevance of a resource.
const root = path.resolve(import.meta.dirname, '..');
const files = ['README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'];
const references = [];
for (const file of files) {
  const source = await fs.readFile(path.join(root, file), 'utf8');
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
      references.push({ file, line: index + 1, label: match[1], url: match[2] });
    }
  }
}
const urls = [...new Set(references.map(item => item.url))];
const results = new Map();
let next = 0;
async function worker() {
  while (next < urls.length) {
    const url = urls[next++];
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AwesomeServiceNowLinkAudit/1.0)', Accept: 'text/html,application/xhtml+xml,*/*' },
          signal: AbortSignal.timeout(25000),
        });
        const body = await response.text();
        const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
        result = { url, status: response.status, finalUrl: response.url, title,
          fragment: new URL(url).hash || '',
          outcome: /page not found|node was not found|^archived\b/i.test(title) ? 'broken-content' : response.ok ? 'reachable' : [403, 429, 999].includes(response.status) ? 'access-blocked' : 'http-error',
          note: response.ok ? 'HTTP success; relevance requires review' : 'Needs review; failure may be access protection',
        };
        if (result.fragment && url.includes('developer.servicenow.com/')) {
          const crawlerUrl = new URL(url);
          crawlerUrl.searchParams.set('_escaped_fragment_', crawlerUrl.hash.replace(/^#!/, ''));
          crawlerUrl.hash = '';
          const route = await fetch(crawlerUrl, { signal: AbortSignal.timeout(25000) });
          const content = await route.text();
          result.routeStatus = route.status;
          result.routeTitle = (content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
          result.note = 'Fragment checked through the developer portal crawler URL; browser routing can still differ';
          if (/page not found|node was not found/i.test(result.routeTitle)) result.outcome = 'broken-content';
          else if (!result.routeTitle || /^(ServiceNow Developers|Home \| ServiceNow Developers)$/i.test(result.routeTitle)) result.outcome = 'route-unverified';
        } else if(result.fragment) {
          result.outcome = 'route-unverified';
          result.note = 'HTTP fragments are not sent to the server; requires browser review';
        }
        if (![429, 500, 502, 503, 504].includes(response.status)) break;
      } catch (error) {
        result = { url, status: null, finalUrl: '', title: '', fragment: new URL(url).hash || '', outcome: 'request-error', note: `${error.message}: ${error.cause?.code ?? ''}` };
      }
    }
    results.set(url, result);
    console.log(`${results.size}/${urls.length} ${result.status ?? 'ERROR'} ${url}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
const output = { checkedAt: new Date().toISOString(), references: references.length, uniqueUrls: urls.length,
  results: urls.map(url => ({ ...results.get(url), references: references.filter(item => item.url === url) })) };
await fs.mkdir(path.join(root, 'audit'), { recursive: true });
await fs.writeFile(path.join(root, 'audit', 'link-check.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ uniqueUrls: urls.length, statuses: output.results.reduce((counts, item) => {
  counts[item.status ?? 'ERROR'] = (counts[item.status ?? 'ERROR'] ?? 0) + 1; return counts;
}, {}) }));
process.exitCode = output.results.some(item => [404, 410].includes(item.status) || item.outcome === 'broken-content') ? 1 : 0;
