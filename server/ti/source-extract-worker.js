import { parentPort, workerData } from 'node:worker_threads';
import { parse } from 'parse5';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'nav', 'footer', 'aside']);
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'figcaption']);

function nodeText(root, maxNodes) {
  const stack = [root];
  const parts = [];
  let nodes = 0;
  let capped = false;
  while (stack.length > 0) {
    const node = stack.pop();
    nodes += 1;
    if (nodes > maxNodes) { capped = true; break; }
    const tag = node.tagName?.toLowerCase();
    if (tag && SKIP_TAGS.has(tag)) continue;
    if (node.attrs?.some((attr) => attr.name.toLowerCase() === 'hidden' || (attr.name.toLowerCase() === 'aria-hidden' && attr.value.toLowerCase() === 'true'))) continue;
    if (node.nodeName === '#text' && node.value) parts.push(node.value);
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return { text: parts.join(' ').replace(/\s+/gu, ' ').trim(), capped };
}

function elementByTag(root, tagName, maxNodes) {
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < maxNodes) {
    const node = stack.pop();
    visited += 1;
    if (node.tagName?.toLowerCase() === tagName) return node;
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return undefined;
}

function boundExtractedResult(result, maxTextCodePoints, maxBlocks) {
  const titleCodePoints = Array.from(result.title);
  const title = titleCodePoints.slice(0, maxTextCodePoints).join('');
  let remaining = maxTextCodePoints - Array.from(title).length;
  let truncated = result.truncated || title !== result.title;
  const blocks = [];
  for (const block of result.blocks) {
    if (blocks.length >= maxBlocks) { truncated = true; break; }
    const codePoints = Array.from(block);
    if (codePoints.length === 0) continue;
    if (blocks.length > 0) {
      if (remaining < 2) { truncated = true; break; }
      remaining -= 2;
    }
    if (remaining <= 0) { truncated = true; break; }
    if (codePoints.length > remaining) {
      blocks.push(codePoints.slice(0, remaining).join(''));
      remaining = 0;
      truncated = true;
      break;
    }
    blocks.push(block);
    remaining -= codePoints.length;
  }
  return { title, blocks, truncated };
}

function collectHtmlBlocks(root, maxNodes, maxBlocks) {
  const titleNode = elementByTag(root, 'title', maxNodes);
  const title = titleNode ? nodeText(titleNode, maxNodes).text : '';
  const articleNodes = [];
  const mainNodes = [];
  const discovery = [root];
  let visited = 0;
  let truncated = false;
  while (discovery.length > 0) {
    const node = discovery.pop();
    visited += 1;
    if (visited > maxNodes) { truncated = true; break; }
    const tag = node.tagName?.toLowerCase();
    if (tag && SKIP_TAGS.has(tag)) continue;
    if (node.attrs?.some((attr) => attr.name.toLowerCase() === 'hidden' || (attr.name.toLowerCase() === 'aria-hidden' && attr.value.toLowerCase() === 'true'))) continue;
    if (tag === 'article') {
      articleNodes.push(node);
      continue;
    }
    if (tag === 'main') mainNodes.push(node);
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) discovery.push(children[i]);
  }
  const contentRoots = articleNodes.length > 0 ? articleNodes : mainNodes.length > 0 ? mainNodes : [root];
  const blocks = [];
  const fallback = contentRoots.length === 1 && contentRoots[0] === root;
  const stack = [...contentRoots].reverse();
  let nodesVisited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    nodesVisited += 1;
    if (nodesVisited > maxNodes) { truncated = true; break; }
    const tag = node.tagName?.toLowerCase();
    if (tag && SKIP_TAGS.has(tag)) continue;
    if (node.attrs?.some((attr) => attr.name.toLowerCase() === 'hidden' || (attr.name.toLowerCase() === 'aria-hidden' && attr.value.toLowerCase() === 'true'))) continue;
    if (tag && BLOCK_TAGS.has(tag)) {
      const text = nodeText(node, Math.max(1, maxNodes - nodesVisited + 1)).text;
      if (text) {
        if (blocks.length >= maxBlocks) { truncated = true; break; }
        blocks.push(text);
      }
      continue;
    }
    if (fallback && node.nodeName === '#text' && node.value?.trim()) {
      if (blocks.length >= maxBlocks) { truncated = true; break; }
      blocks.push(node.value.trim());
    }
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  if (blocks.length === 0 && !fallback) {
    for (const contentRoot of contentRoots) {
      const extracted = nodeText(contentRoot, maxNodes);
      if (extracted.text) blocks.push(extracted.text);
      if (extracted.capped) truncated = true;
      if (blocks.length >= maxBlocks) {
        if (contentRoots.indexOf(contentRoot) < contentRoots.length - 1) truncated = true;
        break;
      }
    }
  }
  return {
    title,
    blocks: blocks.map((block) => block.replace(/\s+/gu, ' ').trim()).filter(Boolean).slice(0, maxBlocks),
    truncated,
  };
}

try {
  const { html, contentType, maxHtmlNodes, maxEvidenceBlocks, maxTextCodePoints } = workerData;
  if (contentType === 'text/plain') {
    const normalized = html.replace(/\r\n?/gu, '\n').trim();
    const chunks = normalized.split(/\n\s*\n/gu).map((chunk) => chunk.replace(/\s+/gu, ' ').trim()).filter(Boolean);
    parentPort.postMessage(boundExtractedResult({
      title: '',
      blocks: chunks.slice(0, maxEvidenceBlocks),
      truncated: chunks.length > maxEvidenceBlocks,
    }, maxTextCodePoints, maxEvidenceBlocks));
  } else {
    const document = parse(html);
    parentPort.postMessage(boundExtractedResult(
      collectHtmlBlocks(document, maxHtmlNodes, maxEvidenceBlocks),
      maxTextCodePoints,
      maxEvidenceBlocks,
    ));
  }
} catch {
  parentPort.postMessage({ error: 'extraction_failed' });
}
