// Message HTML is hostile input. This pass removes anything that can run code, submit data or
// phone home, and the client still shows the result inside a sandboxed frame with its own
// content security policy. Neither layer is trusted alone.

const REMOVE = 'script, iframe, frame, frameset, object, embed, applet, form, input, button, select, textarea, link, meta, base, svg, math, audio, video, source, track, noscript, template';
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'background', 'poster', 'xlink:href', 'ping'];

function isRemote(url: string): boolean {
  return /^(https?:)?\/\//i.test(url.trim());
}

function isSafeLink(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u.startsWith('http://') || u.startsWith('https://') || u.startsWith('mailto:') || u.startsWith('tel:') || u.startsWith('#');
}

export async function cleanHtml(html: string, options: { loadImages: boolean; inline?: Map<string, string> }): Promise<{ html: string; hasRemoteImages: boolean }> {
  let hasRemoteImages = false;

  const rewriter = new HTMLRewriter()
    .on(REMOVE, {
      element(el) {
        el.remove();
      },
    })
    .on('style', {
      text(chunk) {
        // No remote fetches from CSS: they are tracking pixels by another name.
        if (/url\s*\(|@import/i.test(chunk.text)) {
          chunk.replace(chunk.text.replace(/@import[^;]*;?/gi, '').replace(/url\s*\([^)]*\)/gi, 'none'));
        }
      },
    })
    .on('*', {
      element(el) {
        for (const pair of [...el.attributes]) {
          const name = pair[0] ?? '';
          const value = pair[1] ?? '';
          const attr = name.toLowerCase();
          if (attr.startsWith('on') || attr === 'srcdoc' || attr === 'srcset' || attr === 'formaction' || attr === 'ping') {
            el.removeAttribute(name);
            continue;
          }
          if (attr === 'style' && /url\s*\(|expression\s*\(/i.test(value)) {
            el.setAttribute(name, value.replace(/url\s*\([^)]*\)/gi, 'none').replace(/expression\s*\([^)]*\)/gi, ''));
            continue;
          }
          if (!URL_ATTRS.includes(attr)) continue;

          if (el.tagName === 'img' && attr === 'src') {
            if (isRemote(value)) {
              hasRemoteImages = true;
              if (!options.loadImages) {
                el.removeAttribute(name);
                el.setAttribute('data-sadi-mail-blocked', '1');
              }
            } else if (/^cid:/i.test(value.trim())) {
              // A picture that travelled inside the message itself: show it from the stored copy.
              const data = options.inline?.get(value.trim().slice(4).replace(/^<|>$/g, '').toLowerCase());
              if (data) el.setAttribute(name, data);
              else el.removeAttribute(name);
            } else if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(value.trim())) {
              el.removeAttribute(name);
            }
            continue;
          }
          if (attr === 'href' && el.tagName === 'a') {
            if (isSafeLink(value)) {
              el.setAttribute('target', '_blank');
              el.setAttribute('rel', 'noopener noreferrer nofollow');
            } else {
              el.removeAttribute(name);
            }
            continue;
          }
          // Any other URL-bearing attribute (background, poster, …) is dropped.
          el.removeAttribute(name);
        }
      },
    });

  const cleaned = await rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
  return { html: cleaned, hasRemoteImages };
}
