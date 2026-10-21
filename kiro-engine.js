'use strict';
/*
 * Kiro CLI engine adapter.
 *
 * SQUAD/CODE was built to drive headless Claude Code (`claude -p --output-format stream-json`). This module adapts the bridge to
 * drive Kiro CLI (`kiro-cli chat --no-interactive --output-format stream-json`) instead, WITHOUT rewriting the 558 KB UI:
 *
 *   1. buildKiroArgs(opts)  -> the kiro-cli argv for one headless run.
 *   2. makeAcpConverter()   -> a stateful function that turns each Kiro ACP event (JSON Lines) into the Claude-style events the UI
 *                              already understands (system/init, assistant, user, stream_event, result). The bridge then builds the
 *                              final `exit` event exactly as before.
 *
 * Why an adapter instead of changing the UI: app.js consumes a fixed event contract (see src/app.js handleRunEvent / console). By
 * translating at the bridge, every existing screen (console, chat bubbles, tool chips, cost) keeps working unchanged.
 *
 * Kiro CLI differences handled here (kiro-cli 2.24.1, verified against real runs):
 *   - Prompt is a positional [INPUT] argument, not stdin.
 *   - No --max-budget-usd, --permission-mode, --allowedTools(cli), --add-dir, --append-system-prompt-file, --agents(file).
 *   - Trust is --trust-all-tools / --trust-tools=a,b (session-scoped).
 *   - Native agents come from .kiro/agents/<name>.json via --agent <name>.
 *   - Cost is reported in CREDITS (metadata.meteringUsage[].unit === 'credit'), not USD.
 */

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Kiro agent/model names are relaxed slugs; keep validation tight but allow dots, dashes, colons.
const KIRO_AGENT_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const KIRO_MODEL_RE = /^[A-Za-z0-9._:\-\[\]]{1,80}$/;

/**
 * Build the kiro-cli argv for one headless run.
 * @param {object} opts  Validated run options (see server.js validateRunOptions / validateKiroOptions).
 * @param {string} prompt The user/step prompt (goes as the positional [INPUT] argument).
 * @returns {string[]} argv after the `chat` subcommand is NOT included here; caller prepends subcommand.
 */
function buildKiroArgs(opts, prompt) {
  // `stream-json` already implies --no-interactive, but we pass it explicitly for clarity and safety.
  const args = ['chat', '--no-interactive', '--output-format', 'stream-json'];

  // Trust model (headless): a trustTools list restricts to exactly those tools; trustAll===false passes NO trust flag so the
  // selected agent's allowedTools (.kiro/agents/<name>.json) governs; otherwise trust everything (default).
  if (Array.isArray(opts.trustTools)) {
    args.push(`--trust-tools=${opts.trustTools.join(',')}`);
  } else if (opts.trustAll === false) {
    // no trust flag: the agent's allowedTools decides what runs without prompts
  } else {
    args.push('--trust-all-tools');
  }

  if (opts.agent) args.push('--agent', opts.agent);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.agentEngine) args.push('--agent-engine', opts.agentEngine);
  // --mode is V3-only ("default"|"spec"); only emit it with the V3 engine so older engines don't choke on an unknown flag.
  if (opts.mode && opts.agentEngine === 'v3') args.push('--mode', opts.mode);
  if (opts.cloud) args.push('--cloud');
  if (opts.repo) args.push('--repo', opts.repo);
  if (opts.requireMcpStartup) args.push('--require-mcp-startup');
  if (opts.resumeId) args.push('--resume-id', opts.resumeId);

  // Prompt is the positional argument. Must come last and be a single token (spawn passes it as one argv entry, no shell).
  args.push(prompt);
  return args;
}

/** Validate the Kiro-specific option subset. Returns a normalized object; throws on invalid input. */
function validateKiroOptions(o = {}) {
  const out = {};
  if (o.agent) { if (!KIRO_AGENT_RE.test(o.agent)) throw new Error('Agente Kiro inválido.'); out.agent = o.agent; }
  if (o.model) { if (!KIRO_MODEL_RE.test(o.model)) throw new Error('Modelo inválido.'); out.model = o.model; }
  if (o.effort) { if (!EFFORTS.includes(o.effort)) throw new Error('Nível de esforço inválido.'); out.effort = o.effort; }
  if (o.agentEngine) {
    if (!['v1', 'v2', 'v3'].includes(o.agentEngine)) throw new Error('Agent engine inválido (use v1, v2 ou v3).');
    out.agentEngine = o.agentEngine;
  }
  if (o.mode) { if (!['default', 'spec'].includes(o.mode)) throw new Error('Modo inválido (use default ou spec).'); out.mode = o.mode; }
  if (o.cloud) out.cloud = true;
  if (o.repo) { const r = String(o.repo).trim(); if (!/^[A-Za-z0-9._/-]{1,120}(,[A-Za-z0-9._/-]{1,120})*$/.test(r)) throw new Error('Repositório inválido (use owner/name).'); out.repo = r; }
  if (o.requireMcpStartup) out.requireMcpStartup = true;
  if (o.resumeId) { const s = String(o.resumeId).trim(); if (!/^[A-Za-z0-9._-]{1,100}$/.test(s)) throw new Error('Session ID inválido.'); out.resumeId = s; }
  // trustTools: null/undefined => trust-all. Array => only these tools. Bounded + simple token validation.
  if (Array.isArray(o.trustTools)) {
    const tools = o.trustTools.map(String).map(s => s.trim()).filter(Boolean).slice(0, 60);
    for (const t of tools) if (!/^[A-Za-z@][A-Za-z0-9_@/*-]{0,80}$/.test(t)) throw new Error(`Ferramenta inválida: ${t}`);
    out.trustTools = tools;
  }
  // trustAll: default true (headless trusts every tool). false => pass no trust flag so the agent's allowedTools governs.
  out.trustAll = o.trustAll !== false;
  return out;
}

/**
 * Create a stateful converter: call it with each parsed Kiro ACP event; it returns an ARRAY of Claude-style events to push to the
 * UI (may be empty). State is needed because ACP streams text as many small `agent_message_chunk`s and reports cost incrementally.
 *
 * The converter also exposes `.summary()` returning the accumulated run result (final text, credits, duration, session, error) so
 * the bridge can build its `exit` event — the same shape it built from Claude's `result` event.
 */
function makeAcpConverter() {
  const state = {
    sessionId: null,
    engine: null,
    model: null,
    finalText: '',
    credits: 0,          // accumulated metering credits
    turnDurationMs: null,
    status: null,        // 'success' | 'error' | ... from runFinished
    stopReason: null,
    errorText: '',
    toolKinds: new Map(), // toolCallId -> kiro tool name, so tool_call_update can reference it
    toolCount: 0,
    sawInit: false,
  };

  function convert(acp) {
    if (!acp || typeof acp !== 'object') return [];
    const out = [];
    const type = acp.type;
    const data = acp.data || {};

    if (type === 'runStarted') {
      state.engine = data.engine || null;
      // Defer the system/init event until we have the sessionId (comes on the first metadata event).
      return out;
    }

    if (type === 'metadata') {
      if (data.sessionId) state.sessionId = data.sessionId;
      // Emit system/init once, as soon as we know the session (the UI console prints session/model/tools from it).
      if (!state.sawInit && state.sessionId) {
        state.sawInit = true;
        out.push({
          type: 'system', subtype: 'init',
          session_id: state.sessionId,
          model: state.model || data.model || 'kiro',
          permissionMode: 'trust-all',
          engine: state.engine,
          tools: [], // Kiro does not enumerate the toolset here; left empty (UI shows "0 ferramentas").
        });
      }
      // Accumulate credits (meteringUsage can carry several entries per turn).
      if (Array.isArray(data.meteringUsage)) {
        for (const m of data.meteringUsage) if (m && typeof m.value === 'number') state.credits += m.value;
      }
      if (typeof data.turnDurationMs === 'number') state.turnDurationMs = (state.turnDurationMs || 0) + data.turnDurationMs;
      // Surface context usage as a lightweight metadata event (UI ignores unknown types gracefully).
      if (typeof data.contextUsagePercentage === 'number') {
        out.push({ type: 'kiro_metadata', contextUsagePercentage: data.contextUsagePercentage, sessionId: state.sessionId });
      }
      return out;
    }

    if (type === 'sessionUpdate') {
      const u = data.update || {};
      const kind = u.sessionUpdate;

      if (kind === 'agent_message_chunk') {
        const text = u.content && typeof u.content.text === 'string' ? u.content.text : '';
        if (text) {
          state.finalText += text;
          // Two events: the streaming delta (growing chat bubbles) AND an assistant text block (console lines).
          out.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
        }
        return out;
      }

      if (kind === 'tool_call') {
        state.toolCount++;
        if (u.toolCallId) state.toolKinds.set(u.toolCallId, (u._meta && u._meta.kiro && u._meta.kiro.toolName) || u.kind || 'tool');
        const name = (u._meta && u._meta.kiro && u._meta.kiro.toolName) || u.kind || 'tool';
        // Map to Claude's assistant/tool_use so describeTool() in app.js renders a chip.
        out.push({
          type: 'assistant',
          message: { content: [{
            type: 'tool_use',
            id: u.toolCallId || `kiro-tool-${state.toolCount}`,
            name: claudeToolName(name, u),
            input: toolInput(name, u),
          }] },
        });
        return out;
      }

      if (kind === 'tool_call_update') {
        const status = u.status || '';
        const isError = status === 'failed';
        // Only surface a tool_result when there is something to show (errors, or completion). The UI reads user/tool_result.
        const resultText = summarizeOutput(u.rawOutput);
        out.push({
          type: 'user',
          message: { content: [{
            type: 'tool_result',
            tool_use_id: u.toolCallId || '',
            is_error: isError,
            content: isError ? (resultText || 'Falha na ferramenta.') : resultText,
          }] },
        });
        return out;
      }

      // Unknown session update kinds: ignore (forward-compatible).
      return out;
    }

    if (type === 'runFinished') {
      state.status = data.status || null;
      state.stopReason = data.stopReason || null;
      if (typeof data.finalText === 'string' && data.finalText) state.finalText = data.finalText;
      if (data.sessionId) state.sessionId = data.sessionId;
      if (data.status && data.status !== 'success') {
        state.errorText = typeof data.error === 'string' ? data.error : `status ${data.status}`;
      }
      // Emit a Claude-style `result` so the console picks up cost; the bridge still builds the final `exit`.
      out.push({
        type: 'result',
        subtype: state.status === 'success' ? 'success' : 'error',
        is_error: state.status && state.status !== 'success',
        result: state.finalText,
        // We report credits in a dedicated field; total_cost_usd is kept null (Kiro bills credits, not USD).
        total_cost_usd: null,
        credits: round4(state.credits),
        duration_ms: state.turnDurationMs,
        num_turns: null,
        session_id: state.sessionId,
      });
      return out;
    }

    // Unknown top-level types: forward as a raw passthrough so nothing is silently lost in the history.
    return out;
  }

  function summary() {
    const isError = !!(state.status && state.status !== 'success');
    return {
      sessionId: state.sessionId,
      finalText: state.finalText,
      credits: round4(state.credits),
      durationMs: state.turnDurationMs,
      numTurns: null,
      status: state.status,
      stopReason: state.stopReason,
      isError,
      errorText: state.errorText,
      toolCount: state.toolCount,
    };
  }

  convert.summary = summary;
  return convert;
}

/* ---------- helpers ---------- */

// Map a Kiro tool name to a Claude-ish display name so app.js describeTool() produces a sensible chip label.
function claudeToolName(kiroName, u) {
  const k = String(kiroName || '').toLowerCase();
  if (k === 'read' || u.kind === 'read') return 'Read';
  if (k === 'write' || k === 'fs_write' || u.kind === 'edit') return 'Write';
  if (k === 'shell' || k === 'execute_bash' || u.kind === 'execute') return 'Bash';
  if (k === 'grep') return 'Grep';
  if (k === 'glob') return 'Glob';
  if (k.startsWith('web_search')) return 'WebSearch';
  if (k.startsWith('web_fetch')) return 'WebFetch';
  // Fall back to the raw name (UI shows it as-is).
  return kiroName || 'Tool';
}

// Build a Claude-style tool input object so describeTool() can show a path/command. We pass the Kiro rawInput through, plus a few
// normalized aliases the UI looks for (file_path, command).
function toolInput(kiroName, u) {
  const raw = (u.rawInput && typeof u.rawInput === 'object') ? u.rawInput : {};
  const input = { ...raw };
  // locations[0].path is the most reliable path indicator across Kiro tools.
  const loc = Array.isArray(u.locations) && u.locations[0] && u.locations[0].path;
  if (loc && !input.file_path) input.file_path = loc;
  if (raw.command && !input.command) input.command = raw.command;
  if (raw.path && !input.file_path) input.file_path = raw.path;
  return input;
}

// Turn Kiro rawOutput into a short text summary for a tool_result (errors shown in console; success kept brief).
function summarizeOutput(rawOutput) {
  if (rawOutput == null) return '';
  if (typeof rawOutput === 'string') return rawOutput.slice(0, 2000);
  try {
    // Common Kiro shape: { items: [{ Text: "..." }] }
    if (Array.isArray(rawOutput.items)) {
      const text = rawOutput.items.map(it => (it && typeof it.Text === 'string') ? it.Text : '').filter(Boolean).join('\n');
      if (text) return text.slice(0, 2000);
    }
    return JSON.stringify(rawOutput).slice(0, 2000);
  } catch {
    return '';
  }
}

function round4(n) { return typeof n === 'number' && isFinite(n) ? Math.round(n * 10000) / 10000 : n; }

/**
 * Classify a failed run from its stderr + exit code to decide whether to rotate the API key.
 * Returns one of: 'exhausted' (quota/credits/rate), 'auth' (invalid/expired key), 'other' (not key-related).
 *
 * Patterns are intentionally broad and case-insensitive; the bridge treats 'exhausted' and 'auth' as "rotate to next key".
 */
function classifyFailure(stderr = '', code = null) {
  const s = String(stderr || '').toLowerCase();
  // Quota / credit / rate-limit exhaustion -> rotate.
  if (/quota|credit|rate.?limit|too many requests|throttl|usage limit|monthly limit|insufficient|exhaust|limit reached|429/.test(s)) {
    return 'exhausted';
  }
  // Authentication / invalid or expired key -> rotate (the key is unusable).
  if (/not logged in|unauthor|forbidden|invalid api key|expired|authentication|401|403|invalid token|token.*(invalid|expired)/.test(s)) {
    return 'auth';
  }
  return 'other';
}

/** Whether a failure classification means we should try the next key in the pool. */
const shouldRotate = kind => kind === 'exhausted' || kind === 'auth';

/**
 * Human-readable description of a kiro-cli process exit code, used as the error fallback when there is no clearer message from
 * stderr or the ACP stream. Only code 3 is documented by the CLI (MCP startup failure, via --require-mcp-startup); other codes are
 * reported generically to avoid asserting unverified semantics.
 */
function describeExit(code) {
  if (code === 3) return 'kiro-cli saiu com código 3: um servidor MCP exigido não iniciou. Revise a configuração de MCP do agente (ou rode com --require-mcp-startup para diagnosticar).';
  if (code == null) return 'kiro-cli terminou sem código de saída (possível interrupção do processo).';
  return `kiro-cli saiu com código ${code}.`;
}

/**
 * Resolve a requested model id against the kiro-cli catalog. kiro-cli exits 1 on an unknown --model, and legacy/migrated
 * workspaces may carry Claude-era aliases ('sonnet', 'opus'). Returns the requested id if valid (or if the catalog is unknown),
 * otherwise maps an alias to the newest catalog id that mentions it, or '' to fall back to the kiro default ('auto').
 */
function pickModel(requested, ids) {
  if (!requested) return '';
  const list = Array.isArray(ids) ? ids.filter(x => typeof x === 'string' && x) : [];
  if (!list.length || list.includes(requested)) return requested;
  const want = String(requested).toLowerCase();
  const match = list.find(id => id.toLowerCase().includes(want)) || list.find(id => want.includes(id.toLowerCase()));
  return match || '';
}

module.exports = {
  buildKiroArgs,
  pickModel,
  validateKiroOptions,
  makeAcpConverter,
  classifyFailure,
  shouldRotate,
  describeExit,
  // exported for tests
  _internals: { claudeToolName, toolInput, summarizeOutput },
};
