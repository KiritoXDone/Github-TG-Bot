import { Marked } from 'marked';

export const escapeMarkdown = (text) => text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
const escapeCode = (text) => text.replace(/[`\\]/g, '\\$&');
const text = (value, escape = escapeMarkdown) => ({ value, escape });
const wrap = (children, open = '', close = '') => ({ children, open, close });
const prefix = (value, length) => value.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');

export function shouldCollapse(value) {
  const visible = value.trim();
  return visible.length > 600 || visible.split('\n').filter(line => line.trim()).length > 8;
}

// Prefix quote lines without inserting literal '>' into a fenced code block.
// Telegram permits links and code inside quotes, but not nested quotes.
export function quoteMarkdown(value, expandable = true) {
  if (!value) return '';
  let result = expandable ? '**>' : '>';
  let code = 0;
  let link = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\' && i + 1 < value.length) {
      result += char + value[++i];
    } else if (link) {
      result += char;
      if (char === ')') link = false;
    } else if (!code && char === ']' && value[i + 1] === '(') {
      result += '](';
      link = true;
      i++;
    } else if (char === '`') {
      const width = value.startsWith('```', i) ? 3 : 1;
      code = code === width ? 0 : code || width;
      result += '`'.repeat(width);
      i += width - 1;
    } else {
      result += char;
      if (char === '\n' && !code) result += '>';
    }
  }
  return result + (expandable ? '||' : '');
}

const markdown = new Marked({ gfm: true, extensions: [{
  name: 'details', level: 'block',
  start(source) { return source.search(/^ {0,3}<details(?=[\s>])/im); },
  tokenizer(source) {
    const opening = /^ {0,3}<details(?:\s[^>]*)?>/i.exec(source);
    if (!opening) return;
    // Consume the whole block, including blank lines. Nested details are balanced;
    // comments and code examples cannot accidentally close the outer block.
    const markers = /<!--[\s\S]*?(?:-->|$)|(`+|~{3,})[\s\S]*?\1|<\/?details(?:\s[^>]*)?>/gi;
    markers.lastIndex = opening[0].length;
    let depth = 1;
    let end = source.length;
    let bodyEnd = end;
    for (const marker of source.matchAll(markers)) {
      if (/^<details[\s>]/i.test(marker[0])) depth++;
      else if (/^<\/details[\s>]/i.test(marker[0]) && --depth === 0) {
        bodyEnd = marker.index;
        end = marker.index + marker[0].length;
        break;
      }
    }
    let body = source.slice(opening[0].length, bodyEnd).trim();
    const summary = /^<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>\s*/i.exec(body);
    if (summary) body = body.slice(summary[0].length);
    return { type: 'details', raw: source.slice(0, end),
      summary: this.lexer.inlineTokens(summary ? summary[1].replace(/<[^>]*>/g, '').trim() || 'Details' : 'Details'),
      tokens: this.lexer.blockTokens(body), open: /\sopen(?:\s|=|>)/i.test(opening[0]) };
  },
}] });

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
        // Code can be inside quotes, but not emphasis or a link label.
        if (context['*'] || context['_'] || context['~'] || context.link) {
          return [text(token.text), ...(block ? [text('\n\n')] : [])];
        }
        const language = /^[A-Za-z0-9_+-]{1,30}$/.test(token.lang || '') ? token.lang : '';
        return [wrap([text(token.text, escapeCode)], block ? `\`\`\`${language}\n` : '`', block ? '\n```' : '`'),
          ...(block ? [text('\n\n')] : [])];
      }
      case 'link':
      case 'image': {
        const target = !context.link && linkTarget(token.href, base);
        const label = token.type === 'image' ? [text(decode(token.text || 'Image'))] : children({ link: true });
        return target ? [wrap(label, '[', `](${target})`)] : label;
      }
      case 'blockquote': {
        const content = children({ quote: true });
        return context.quote ? content : [{ ...wrap(content), quote: true, trimEnd: true }, text('\n\n')];
      }
      case 'details': {
        const content = [wrap(nodes(token.summary, base, { ...context, quote: true, '*': true }), '*', '*'),
          text('\n'), ...children({ quote: true })];
        // Telegram quotations cannot nest; retain inner headings and prose.
        return context.quote ? content : [{ ...wrap(content), quote: true, expandable: !token.open, keepOpen: token.open, trimEnd: true }, text('\n\n')];
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

const plainText = entries => entries.map(node => 'value' in node ? node.value : plainText(node.children)).join('');
const flattenQuotes = entries => entries.flatMap(node => node.quote ? flattenQuotes(node.children)
  : node.children ? [{ ...node, children: flattenQuotes(node.children) }] : [node]);

function compactBlocks(tree) {
  const result = [];
  let group = [];
  const flush = () => {
    if (shouldCollapse(plainText(group))) {
      result.push({ ...wrap(flattenQuotes(group)), quote: true, expandable: true, trimEnd: true }, text('\n\n'));
    } else result.push(...group);
    group = [];
  };
  for (const node of tree) {
    // Preserve explicit details blocks, so a short Chinese introduction remains
    // visible alongside an already collapsed English translation.
    if (node.quote && (node.expandable || node.keepOpen)) { flush(); result.push(node); }
    else group.push(node);
  }
  flush();
  return result;
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
        if (!content) part = '';
        else if (node.quote) {
          part = quoteMarkdown(content, Boolean(node.expandable));
        } else part = node.open + content + node.close;
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

export function renderMarkdown(source, { budget = 3000, maxText = 2400, base, compact = false } = {}) {
  if (typeof source !== 'string' || !source.trim() || budget <= 0) return '';
  source = source.replace(/\r/g, '').toWellFormed().trim();
  // Bound parsing work independently of GitHub's much larger webhook limit.
  const input = prefix(source, 16000);
  let tree;
  try { tree = nodes(markdown.lexer(input), base); }
  catch { tree = [text(input)]; }
  if (compact) tree = compactBlocks(tree);
  const formatted = (limit) => {
    const { output, truncated } = render(tree, limit);
    if (!truncated && input.length === source.length) return output;
    // The expandable quote marker must remain at the end of its last line.
    return output.endsWith('||') ? `${output.slice(0, -2)}…||` : `${output}…`;
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
