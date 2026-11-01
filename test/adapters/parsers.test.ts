import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePluginDetails, parseTokenCount } from '../../src/adapters/parsers/pluginDetails.ts';
import { parseMcpList } from '../../src/adapters/parsers/mcpList.ts';
import { redactCommandLine } from '../../src/adapters/redact.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

test('token counts in every format the CLI prints', () => {
  assert.equal(parseTokenCount('~48,079'), 48079);
  assert.equal(parseTokenCount('~2.7k'), 2700);
  assert.equal(parseTokenCount('~13.7k'), 13700);
  assert.equal(parseTokenCount('~2k'), 2000);
  assert.equal(parseTokenCount('~600'), 600);
  assert.equal(parseTokenCount('80'), 80);
  assert.equal(parseTokenCount('lots'), undefined);
});

test('ECC details: total and every component row', () => {
  const cost = parsePluginDetails(fixture('details-ecc.txt'));
  assert.equal(cost.alwaysOn, 48079);
  assert.equal(cost.parseError, undefined);
  // 314 skills + 98 commands + 71 agents, as printed by the CLI's own inventory.
  assert.ok(cost.components.length > 400, `got ${cost.components.length} rows`);
  assert.deepEqual(cost.components.find((c) => c.name === 'agent-payment-x402'), { name: 'agent-payment-x402', alwaysOn: 160, onInvoke: 13700 });
  assert.deepEqual(cost.components.at(-1), { name: 'vue-review', alwaysOn: 90, onInvoke: 2100 });
});

test('small plugin and synced plugin details', () => {
  assert.deepEqual(parsePluginDetails(fixture('details-frontend-design.txt')), {
    alwaysOn: 80, components: [{ name: 'frontend-design', alwaysOn: 80, onInvoke: 2700 }],
  });
  const synced = parsePluginDetails(fixture('details-design-synced.txt'));
  assert.equal(synced.alwaysOn, 619);
  assert.equal(synced.components.length, 7);
});

test('unexpected details output reports a parse error instead of throwing', () => {
  assert.deepEqual(parsePluginDetails('something completely different'), {
    components: [], parseError: 'no cost information found in `claude plugin details` output',
  });
});

test('mcp list: every server line from the real sample', () => {
  const { entries, unparsed } = parseMcpList(fixture('mcp-list.txt'));
  assert.deepEqual(unparsed, []);
  assert.equal(entries.length, 23);
  const by = (n: string) => entries.find((e) => e.name === n)!;

  assert.deepEqual(by('claude.ai Gmail').origin, { type: 'connector' });
  assert.equal(by('claude.ai Gmail').status, 'connected');

  const chrome = by('plugin:ecc:chrome-devtools');
  assert.deepEqual([chrome.origin, chrome.shortName, chrome.status], [{ type: 'plugin', pluginName: 'ecc' }, 'chrome-devtools', 'connected']);

  const slack = by('plugin:design:slack');
  assert.deepEqual([slack.target, slack.transport, slack.status], ['https://mcp.slack.com/mcp', 'http', 'needs-auth']);

  assert.equal(by('plugin:design:google calendar').status, 'not-configured');
  assert.equal(by('plugin:design:google calendar').shortName, 'google calendar');

  const aws = by('aws-mcp');
  assert.deepEqual(aws.origin, { type: 'configured' });
  assert.equal(aws.status, 'failed');
  assert.match(aws.statusText, /^Failed to connect — MCP server "aws-mcp" connection timed out/);
});

test('mcp list: unknown lines are kept (redacted) rather than dropped silently', () => {
  const { entries, unparsed } = parseMcpList('Checking MCP server health…\n\nweird line --token abc123\n');
  assert.deepEqual(entries, []);
  assert.deepEqual(unparsed, ['weird line --token ***']);
});

test('redaction masks secrets but keeps ordinary commands readable', () => {
  assert.equal(redactCommandLine('npx -y chrome-devtools-mcp@1.10.1'), 'npx -y chrome-devtools-mcp@1.10.1');
  assert.equal(redactCommandLine('srv --api-key sk-live-123 --port 80'), 'srv --api-key *** --port 80');
  assert.equal(redactCommandLine('srv --token=abc API_KEY=xyz'), 'srv --token=*** API_KEY=***');
  assert.equal(redactCommandLine('srv aaaaBBBBccccDDDDeeeeFFFFgggg1234567890'), 'srv ***');
  assert.equal(redactCommandLine('https://u:p@x.com/mcp?key=s3cret'), 'https://***@x.com/mcp?key=***');
  assert.equal(redactCommandLine('uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp --metadata INSTALL_SOURCE=aws-cli'),
    'uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp --metadata INSTALL_SOURCE=aws-cli');
});
