/** Workers AI style SSE body: one `data: {"response": ...}` event per token, then [DONE]. */
export function sseBody(tokens) {
  return tokens.map((t) => `data: ${JSON.stringify({ response: t })}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** A stream that delivers `text` as UTF-8 in reads of `size` bytes (may split characters). */
export function chunkedStream(text, size) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

/**
 * Asserts that a DOM subtree cannot run script: no script-capable elements, no
 * inline event handler attributes, and no javascript: URLs.
 */
export function expectInert(expect, root) {
  expect(root.querySelector('script, iframe, object, embed, svg, math, style, form, base, meta, link')).toBeNull();
  for (const node of root.querySelectorAll('*')) {
    for (const attr of node.attributes) {
      expect(attr.name.toLowerCase().startsWith('on'), `${node.tagName} ${attr.name}`).toBe(false);
      expect(/^\s*(javascript|data|vbscript):/i.test(attr.value), `${node.tagName} ${attr.name}=${attr.value}`).toBe(false);
    }
  }
}

/** Payloads that run script if inserted into the page as raw HTML. */
export const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '"><img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '<svg onload=alert(1)></svg>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click</a>',
  '<details open ontoggle=alert(1)>x</details>',
  '[click](javascript:alert(1))',
  '<math><mi xlink:href="data:x,<script>alert(1)</script>"></mi></math>',
];
