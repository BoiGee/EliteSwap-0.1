import type { ReactElement } from 'npm:react@18.3.1'
import { renderToReadableStream } from 'npm:react-dom@18.3.1/server'
import { convert } from 'npm:html-to-text@9.0.5'
import { plainTextSelectors } from 'npm:@react-email/render@0.0.17'

const DOCTYPE = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">'

// Same output as @react-email's renderAsync (same react-dom, doctype, and plain-text selectors),
// except its stream reader decodes each chunk on its own, so any multi-byte character that lands
// on a chunk boundary (bullets, accents, emoji) comes out as "��".
export async function renderEmail(element: ReactElement): Promise<{ html: string; text: string }> {
  const markup = await new Response(await renderToReadableStream(element)).text()
  return {
    html: `${DOCTYPE}${markup.replace(/<!DOCTYPE.*?>/, '')}`,
    text: convert(markup, { selectors: plainTextSelectors }),
  }
}
