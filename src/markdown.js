import { Lexer } from 'marked';

export const escapeMarkdown = (text) => text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
const escapeCode = (text) => text.replace(/[`\\]/g, '\\$&');
const text = (value, escape = escapeMarkdown) => ({ value, escape });
const wrap = (children, open = '', close = '') => ({ children, open, close });
const prefix = (value, length) => value.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');

function decode(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function linkTarget(value, base) {
  try {
    const target = new URL(decode(value), base);
    return ['https:', 'http:'].includes(target.protocol) && !target.username && !target.password
      && target.href.length <= 1000 ? target.href.replace(/[)\\]/g, '\\$&') : '';
  } catch { return ''; }
}

// Parse GitHub Markdown once, then keep text and entity delimiters separate.
// Truncation below only shortens text; URLs and closing delimiters stay intact.
function nodes(tokens, base, context = {}) {
  return tokens.flatMap(token => {
    const children = (extra = {}) => nodes(token.tokens || [], base, { ...context, ...extra });
    const styled = (style) => context[style] ? children() : [wrap(children({ [style]: true }), style, style)];
    switch (token.type) {
      case 'space':
      case 'def': return [];
      case 'paragraph': return [...children(), text('\n\n')];
      case 'heading': return [...styled('*'), text('\n\n')];
      case 'strong': return styled('*');
      case 'em': return styled('_');
      case 'del': return styled('~');
      case 'br': return [text('\n')];
      case 'hr': return [text('────\n\n')];
      case 'checkbox': return []; // The list item supplies its own task marker.
      case 'text': return token.tokens ? children() : [text(decode(token.text))];
      case 'escape': return [text(token.text)];
      case 'html': // Raw HTML is never interpreted as Telegram markup.
        if (/^<!--/.test(token.text)) return [];
        if (/^<br\s*\/?\s*>$/i.test(token.text)) return [text('\n')];
        return [text(token.text)];
      case 'codespan':
      case 'code': {
        const block = token.type === 'code';
        // Telegram forbids code inside another entity. Preserve its text there.
        if (context['*'] || context['_'] || context['~'] || context.link || context.quote) {
          return [text(token.text), ...(block ? [text('\n\n')] : [])];
        }
        const language = /^[A-Za-z0-9_+-]{1,30}$/.test(token.lang || '') ? token.lang : '';
        return [wrap([text(token.text, escapeCode)], block ? `\`\`\`${language}\n` : '`', block ? '\n```' : '`'),
          ...(block ? [text('\n\n')] : [])];
      }
      case 'link':
      case 'image': {
        const target = !context.link && !context.quote && linkTarget(token.href, base);
        const label = token.type === 'image' ? [text(decode(token.text || 'Image'))] : children({ link: true });
        return target ? [wrap(label, '[', `](${target})`)] : label;
      }
      case 'blockquote': {
        const content = children({ quote: true });
        return context.quote ? content : [{ ...wrap(content), quote: true, trimEnd: true }, text('\n\n')];
      }
      case 'list':
        return [...(context.indent ? [text('\n')] : []), ...token.items.flatMap((item, index) => [
          text(`${'  '.repeat(context.indent || 0)}${item.task ? (item.checked ? '☑' : '☐') : token.ordered ? `${token.start + index}.` : '•'} `),
          { ...wrap(nodes(item.tokens, base, { ...context, indent: (context.indent || 0) + 1 })), trimEnd: true }, text('\n'),
        ]), text('\n')];
      case 'table':
        // Telegram has no native Markdown table: retain readable rows and links.
        return [...[token.header, ...token.rows].flatMap((row, index) => [
          ...row.flatMap((cell, column) => [
            ...(column ? [text(' | ')] : []),
            ...(index === 0 ? [wrap(nodes(cell.tokens, base, { ...context, '*': true }), '*', '*')]
              : nodes(cell.tokens, base, context)),
          ]), text('\n'),
        ]), text('\n')];
      default: return [text(token.text || token.raw || '')];
    }
  });
}

function render(tree, limit) {
  let remaining = limit;
  let truncated = false;
  const visit = (entries) => {
    let result = '';
    for (const node of entries) {
      let part;
      if ('value' in node) {
        const value = prefix(node.value, remaining);
        remaining -= value.length;
        if (value.length < node.value.length) { truncated = true; remaining = 0; }
        part = node.escape(value);
      } else {
        let content = visit(node.children);
        if (node.trimEnd) content = content.trimEnd();
        part = content ? node.quote ? content.split('\n').map(line => `>${line}`).join('\n')
          : node.open + content + node.close : '';
      }
      // Adjacent italic entities must not accidentally become an underline.
      if (result.endsWith('_') && part.startsWith('_')) result += '**';
      result += part;
    }
    return result;
  };
  const output = visit(tree).trim();
  return { output, truncated };
}

export function renderMarkdown(source, { budget = 3000, maxText = 2400, base } = {}) {
  if (typeof source !== 'string' || !source.trim() || budget <= 0) return '';
  source = source.replace(/\r/g, '').toWellFormed().trim();
  // Bound parsing work independently of GitHub's much larger webhook limit.
  const input = prefix(source, 16000);
  let tree;
  try { tree = nodes(Lexer.lex(input, { gfm: true }), base); }
  catch { tree = [text(input)]; }
  const formatted = (limit) => {
    const { output, truncated } = render(tree, limit);
    return output + (truncated || input.length < source.length ? '…' : '');
  };
  if (formatted(maxText).length <= budget) return formatted(maxText);
  let low = 0;
  let high = maxText;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (formatted(mid).length <= budget) low = mid;
    else high = mid - 1;
  }
  return formatted(low);
}
