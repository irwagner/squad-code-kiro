'use strict';
// Quick sanity test for the ACP->Claude converter using the real events captured from kiro-cli.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeAcpConverter, buildKiroArgs, validateKiroOptions } = require('../kiro-engine.js');

const events = [
  { type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v2' } },
  { type: 'metadata', data: { sessionId: 'S1', contextUsagePercentage: 8.57 } },
  { type: 'sessionUpdate', data: { sessionId: 'S1', update: { sessionUpdate: 'tool_call', toolCallId: 'T1', title: 'Reading listing', kind: 'read', locations: [{ path: 'E:\\x\\y' }], rawInput: { operations: [{ mode: 'Directory', path: 'E:\\x\\y' }] }, _meta: { kiro: { toolName: 'read' } } } } },
  { type: 'sessionUpdate', data: { sessionId: 'S1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'T1', kind: 'read', status: 'completed', rawOutput: { items: [{ Text: 'file1\nfile2' }] } } } },
  { type: 'sessionUpdate', data: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } } } },
  { type: 'sessionUpdate', data: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } } } },
  { type: 'metadata', data: { sessionId: 'S1', contextUsagePercentage: 3.4, meteringUsage: [{ value: 0.121, unit: 'credit', unitPlural: 'credits' }, { value: 0.086, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 5587 } },
  { type: 'runFinished', data: { sessionId: 'S1', status: 'success', stopReason: 'end_turn', finalText: 'Hello world', finalTextTruncated: false } },
];

const convert = makeAcpConverter();
const emitted = [];
for (const e of events) for (const c of convert(e)) emitted.push(c);

const types = emitted.map(e => e.type + (e.subtype ? '/' + e.subtype : ''));
console.log('EMITTED TYPES:', types.join(', '));

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); }

assert(types.includes('system/init'), 'system/init emitted');
const init = emitted.find(e => e.type === 'system');
assert(init.session_id === 'S1', 'init has session id');

const toolUse = emitted.find(e => e.type === 'assistant' && e.message.content[0].type === 'tool_use');
assert(toolUse && toolUse.message.content[0].name === 'Read', 'tool_call -> assistant/tool_use name=Read');
assert(toolUse.message.content[0].input.file_path === 'E:\\x\\y', 'tool input has file_path from locations');

const toolResult = emitted.find(e => e.type === 'user');
assert(toolResult && toolResult.message.content[0].type === 'tool_result', 'tool_call_update -> user/tool_result');
assert(toolResult.message.content[0].is_error === false, 'completed tool not error');

const deltas = emitted.filter(e => e.type === 'stream_event');
assert(deltas.length === 2, 'two text deltas');
assert(deltas.map(d => d.event.delta.text).join('') === 'Hello world', 'deltas concatenate to text');

const result = emitted.find(e => e.type === 'result');
assert(result && result.credits === 0.207, 'credits accumulated (0.121+0.086=0.207), got ' + (result && result.credits));
assert(result.duration_ms === 5587, 'duration from turnDurationMs');
assert(result.is_error === false, 'success not error');

const s = convert.summary();
assert(s.finalText === 'Hello world', 'summary final text');
assert(s.credits === 0.207, 'summary credits');
assert(s.toolCount === 1, 'summary tool count');

// buildKiroArgs
const args = buildKiroArgs(validateKiroOptions({ agent: 'kiro_default', model: 'claude-sonnet-4', effort: 'high' }), 'faça X');
console.log('ARGS:', JSON.stringify(args));
assert(args[0] === 'chat' && args.includes('--no-interactive') && args.includes('--output-format'), 'args base');
assert(args.includes('--trust-all-tools'), 'trust-all by default');
assert(args.includes('--agent') && args.includes('kiro_default'), 'agent flag');
assert(args[args.length - 1] === 'faça X', 'prompt is last positional');

// trust-tools restriction
const args2 = buildKiroArgs(validateKiroOptions({ trustTools: ['read', 'grep'] }), 'p');
assert(args2.some(a => a === '--trust-tools=read,grep'), 'trust-tools restricts, got ' + JSON.stringify(args2));

// trustAll:false => no trust flag at all (the selected agent's allowedTools governs)
const args3 = buildKiroArgs(validateKiroOptions({ trustAll: false }), 'p');
assert(!args3.includes('--trust-all-tools') && !args3.some(a => String(a).startsWith('--trust-tools')), 'trustAll:false passes no trust flag, got ' + JSON.stringify(args3));

// native extras: mode (v3 only), cloud+repo, require-mcp-startup, resume-id
const args4 = buildKiroArgs(validateKiroOptions({ agentEngine: 'v3', mode: 'spec', cloud: true, repo: 'me/app', requireMcpStartup: true, resumeId: 'SID-1' }), 'p');
assert(args4.some((a, i) => a === '--agent-engine' && args4[i + 1] === 'v3'), 'agent-engine v3');
assert(args4.some((a, i) => a === '--mode' && args4[i + 1] === 'spec'), 'mode spec with v3');
assert(args4.includes('--cloud') && args4.some((a, i) => a === '--repo' && args4[i + 1] === 'me/app'), 'cloud+repo');
assert(args4.includes('--require-mcp-startup'), 'require-mcp-startup');
assert(args4.some((a, i) => a === '--resume-id' && args4[i + 1] === 'SID-1'), 'resume-id');
// --mode is dropped when the engine is not v3
const args5 = buildKiroArgs(validateKiroOptions({ agentEngine: 'v2', mode: 'spec' }), 'p');
assert(!args5.includes('--mode'), 'mode dropped when engine != v3');

console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL CONVERTER TESTS PASSED');
