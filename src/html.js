import { Parser } from 'htmlparser2';
import { Lexer } from 'marked';

function tagEnd(source, start) {
  if (source.startsWith('<!--', start)) {
    const end = source.indexOf('-->', start + 4);
    return end < 0 ? source.length : end + 3;
  }
  let quote = '';
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i + 1;
  }
  return source.length;
}

// Marked emits opening/closing inline tags separately and may split an HTML
// container around Markdown paragraphs. Keep those Markdown tokens intact while
// a real HTML parser groups the tags, attributes and implicit closing elements.
export function groupHtml(tokens) {
  if (!tokens.some(token => token.type === 'html')) return tokens;
  const root = { tokens: [] };
  const stack = [root];
  const appendText = value => {
    if (!value) return;
    const children = stack.at(-1).tokens;
    if (children.at(-1)?.type === 'html_text') children.at(-1).text += value;
    else children.push({ type: 'html_text', text: value });
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      const node = { type: 'html_element', name, attrs, tokens: [] };
      stack.at(-1).tokens.push(node);
      stack.push(node);
    },
    onclosetag() { if (stack.length > 1) stack.pop(); },
    ontext: appendText,
  }, { decodeEntities: false, recognizeSelfClosing: true });
  for (const token of tokens) {
    if (token.type !== 'html') { stack.at(-1).tokens.push(token); continue; }
    // Shield Markdown code examples inside an HTML container. Tags in quoted
    // attributes/comments are consumed whole before looking for code fences.
    const source = token.text;
    const markers = /<(?=!--|!|\/?[A-Za-z][\w:-]*(?:\s|\/?>))|^ {0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)|`+/gm;
    const lexer = new Lexer();
    let end = 0;
    for (let match; (match = markers.exec(source));) {
      appendText(source.slice(end, match.index));
      if (match[0] === '<') {
        markers.lastIndex = tagEnd(source, match.index);
        parser.write(source.slice(match.index, markers.lastIndex));
      }
      else {
        const literal = stack.some(node => ['pre', 'code', 'kbd', 'samp', 'script', 'style'].includes(node.name));
        const rest = source.slice(match.index);
        const code = !literal && (lexer.tokenizer.fences(rest) || lexer.tokenizer.codespan(rest));
        if (code) {
          stack.at(-1).tokens.push(code);
          markers.lastIndex = match.index + code.raw.length;
        } else appendText(match[0]);
      }
      end = markers.lastIndex;
    }
    appendText(source.slice(end));
  }
  parser.end();
  return root.tokens;
}
