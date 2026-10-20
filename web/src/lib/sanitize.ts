// The one way LFG puts HTML from a server or an agent into the page.
//
// Agent replies can carry text from anywhere an agent read (a web page, an
// email). Rendered raw, one injected tag could act with this page's rights —
// on Calyx Cloud, with a pass for the whole vault (LFG plan, section 5). So
// every string that goes into `dangerouslySetInnerHTML` passes through here
// first: scripts, event handlers, frames, forms and inline styles are removed.
// (Streamdown, which draws assistant replies, already strips raw HTML itself.)

import DOMPurify from "dompurify";

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["style"],
  });
}
