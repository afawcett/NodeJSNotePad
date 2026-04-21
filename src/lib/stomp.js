/**
 * Minimal STOMP 1.1 framing compatible with stomp.js over SockJS (Spring-style broker).
 */

function buildFrame(command, headers, body = '') {
  let frame = `${command}\n`;
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      frame += `${key}:${value}\n`;
    }
  }
  frame += '\n';
  frame += body;
  frame += '\0';
  return frame;
}

function parseFrames(raw) {
  const frames = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length - 1; i++) {
    const chunk = parts[i];
    if (!chunk.trim()) continue;
    const parsed = parseOneFrame(chunk);
    if (parsed) frames.push(parsed);
  }
  return { frames, rest: parts[parts.length - 1] };
}

function parseOneFrame(text) {
  const headerEnd = text.indexOf('\n\n');
  if (headerEnd === -1) return null;
  const headerBlock = text.slice(0, headerEnd);
  const body = text.slice(headerEnd + 2);
  const lines = headerBlock.split('\n');
  if (lines.length === 0) return null;
  const command = lines[0].trim();
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return { command, headers, body };
}

module.exports = { buildFrame, parseFrames };
