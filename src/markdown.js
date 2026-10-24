import { Marked } from 'marked';
import { decodeHTML as decode } from 'entities';
import { groupHtml } from './html.js';

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
      summary: this.lexer.inlineTokens(summary ? summary[1].trim() || 'Details' : 'Details'),
      tokens: this.lexer.blockTokens(body), open: /\sopen(?:\s|=|>)/i.test(opening[0]) };
  },
}] });

function linkTarget(value, base) {
  try {
    const target = new URL(decode(value), base);
    return ['https:', 'http:'].includes(target.protocol) && !target.username && !target.password
      && target.href.length <= 1000 ? target.href.replace(/[)\\]/g, '\\$&') : '';
  } catch { return ''; }
}

const hiddenTags = new Set(['script', 'style', 'head', 'template', 'iframe', 'object', 'noscript', 'svg', 'math']);
const blockTags = new Set(['address', 'article', 'aside', 'div', 'section', 'main', 'header', 'footer', 'nav',
  'p', 'figure', 'figcaption', 'center', 'dl', 'dd']);
const isBlockToken = token => ['paragraph', 'heading', 'list', 'table', 'blockquote', 'code', 'details'].includes(token.type)
  || token.type === 'html_element' && (blockTags.has(token.name) || /^h[1-6]$/.test(token.name)
    || ['ul', 'ol', 'table', 'blockquote', 'details', 'pre', 'br', 'hr', 'dt', 'li'].includes(token.name));
const htmlStyles = { b: '*', strong: '*', i: '_', em: '_', s: '~', strike: '~', del: '~', u: '__', ins: '__', 'tg-spoiler': '||' };
const styledContext = context => ['*', '_', '~', '__', '||'].some(style => context[style]);
const inlineTokens = source => markdown.Lexer.lexInline(source, markdown.defaults);
const block = children => ({ ...wrap(children), block: true, trimEnd: true });

// Used for code and the depth limit. Walk iteratively so malformed/deep HTML
// cannot exhaust the stack. Markdown delimiters inside HTML code remain literal.
function rawText(tokens) {
  let result = '';
  const pending = [...tokens].reverse();
  while (pending.length) {
    const token = pending.pop();
    if (token.type === 'html_element') {
      if (!hiddenTags.has(token.name)) pending.push(...[...token.tokens].reverse());
    } else result += decode(token.raw ?? token.text ?? '');
  }
  return result;
}

function quoteNodes(content, context, expandable = false, keepOpen = false) {
  if (context.quote || context.link || styledContext(context)) return content;
  return [{ ...wrap(content), quote: true, expandable, keepOpen, trimEnd: true }, text('\n\n')];
}

function htmlNodes(token, base, context) {
  const { name, attrs, tokens } = token;
  if (hiddenTags.has(name) || Object.hasOwn(attrs, 'hidden')) return [];
  const children = (extra = {}, entries = tokens) => nodes(entries, base, { ...context, htmlBlock: false, ...extra });
  const style = Object.hasOwn(htmlStyles, name) ? htmlStyles[name]
    : name === 'span' && decode(attrs.class || '').split(/\s+/).includes('tg-spoiler') ? '||' : '';
  if (style) return context[style] ? children() : [wrap(children({ [style]: true }), style, style)];
  if (/^h[1-6]$/.test(name) || name === 'dt' || name === 'summary') {
    return [block(context['*'] ? children() : [wrap(children({ '*': true }), '*', '*')])];
  }
  if (name === 'br') return [text('\n')];
  if (name === 'hr') return [block([text('────')])];
  if (name === 'a' || name === 'img' || name === 'video' || name === 'audio') {
    const source = attrs[name === 'a' ? 'href' : 'src'];
    const target = source && !context.link && linkTarget(source, base);
    const label = name === 'a' ? children({ link: true })
      : [text(decode(attrs.alt || attrs.title || ({ img: 'Image', video: 'Video', audio: 'Audio' })[name]))];
    return target ? [wrap(label, '[', `](${target})`)] : label;
  }
  if (name === 'code' || name === 'pre' || name === 'kbd' || name === 'samp' || name === 'tt') {
    const value = rawText(tokens);
    if (styledContext(context) || context.link) return [text(value), ...(name === 'pre' ? [text('\n\n')] : [])];
    if (name !== 'pre') return [wrap([text(value, escapeCode)], '`', '`')];
    const code = tokens.find(child => child.name === 'code');
    const language = /(?:^|\s)language-([A-Za-z0-9_+-]{1,30})(?:\s|$)/.exec(decode(code?.attrs.class || attrs.class || ''))?.[1] || '';
    return [block([wrap([text(value.replace(/^\n/, '').replace(/\n$/, ''), escapeCode)], `\`\`\`${language}\n`, '\n```')])];
  }
  if (name === 'blockquote') {
    return quoteNodes(children({ quote: true, htmlBlock: true }), context, Object.hasOwn(attrs, 'expandable'));
  }
  if (name === 'details') {
    const summary = tokens.find(child => child.name === 'summary');
    const heading = summary ? children({ '*': true, quote: true }, summary.tokens) : [text('Details')];
    return quoteNodes([wrap(heading, '*', '*'), text('\n'),
      ...children({ quote: true, htmlBlock: true }, tokens.filter(child => child !== summary))],
    context, !Object.hasOwn(attrs, 'open'), Object.hasOwn(attrs, 'open'));
  }
  if (name === 'ul' || name === 'ol') {
    let number = /^-?\d{1,6}$/.test(attrs.start || '') ? Number(attrs.start) : 1;
    const items = tokens.filter(child => child.name === 'li');
    return [...(context.indent ? [text('\n')] : []), ...items.flatMap(item => {
      if (/^-?\d{1,6}$/.test(item.attrs.value || '')) number = Number(item.attrs.value);
      const checkbox = item.tokens.find(child => child.name === 'input' && child.attrs.type?.toLowerCase() === 'checkbox');
      const marker = checkbox ? Object.hasOwn(checkbox.attrs, 'checked') ? '☑' : '☐' : name === 'ol' ? `${number++}.` : '•';
      const content = children({ indent: (context.indent || 0) + 1, htmlBlock: true, htmlTask: true }, item.tokens);
      if (content[0] && 'value' in content[0]) content[0].value = content[0].value.trimStart();
      return [text(`${'  '.repeat(context.indent || 0)}${marker} `),
        { ...wrap(content), trimEnd: true }, text('\n')];
    }), text('\n')];
  }
  if (name === 'input') return attrs.type?.toLowerCase() === 'checkbox' && !context.htmlTask
    ? [text(Object.hasOwn(attrs, 'checked') ? '☑ ' : '☐ ')] : [];
  if (name === 'table') {
    const rows = tokens.flatMap(child => ['thead', 'tbody', 'tfoot'].includes(child.name) ? child.tokens : [child]).filter(child => child.name === 'tr');
    const caption = tokens.find(child => child.name === 'caption');
    return [block([...(caption ? [wrap(children({ '*': true }, caption.tokens), '*', '*'), text('\n')] : []),
      ...rows.flatMap(row => [
        ...row.tokens.filter(cell => ['th', 'td'].includes(cell.name)).flatMap((cell, index) => [
          ...(index ? [text(' | ')] : []),
          ...(cell.name === 'th' && !context['*'] ? [wrap(children({ '*': true }, cell.tokens), '*', '*')] : children({}, cell.tokens)),
        ]), text('\n'),
      ]),
    ])];
  }
  if (blockTags.has(name) || name === 'li') return [block(children({ htmlBlock: true }))];
  // Layout, font-size and unknown tags have no Telegram text equivalent.
  return children();
}

// Parse GitHub Markdown and HTML, keeping text and entity delimiters separate.
// Truncation below only shortens text; URLs and closing delimiters stay intact.
function nodes(tokens, base, context = {}) {
  context = { ...context, depth: (context.depth || 0) + 1 };
  tokens = groupHtml(tokens);
  if (context.depth > 60) return [text(rawText(tokens))];
  return tokens.flatMap((token, index) => {
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
      case 'html_element': return htmlNodes(token, base, context);
      case 'html_text': {
        if (!token.text.trim() && context.htmlBlock) {
          const previous = tokens[index - 1];
          const next = tokens[index + 1];
          return previous && next && !isBlockToken(previous) && !isBlockToken(next) ? [text(' ')] : [];
        }
        const parsed = context.htmlBlock ? markdown.lexer(token.text) : inlineTokens(token.text);
        // A text run interrupted by <a>, <b> or <br> is still one paragraph.
        return nodes(parsed.length === 1 && parsed[0].type === 'paragraph' ? parsed[0].tokens : parsed, base, context);
      }
      case 'codespan':
      case 'code': {
        const block = token.type === 'code';
        // Code can be inside quotes, but not emphasis or a link label.
        if (styledContext(context) || context.link) {
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
        return quoteNodes(content, context);
      }
      case 'details': {
        const content = [wrap(nodes(token.summary, base, { ...context, quote: true, '*': true }), '*', '*'),
          text('\n'), ...children({ quote: true })];
        // Telegram quotations cannot nest; retain inner headings and prose.
        return quoteNodes(content, context, !token.open, token.open);
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

const plainText = entries => entries.map(node => 'value' in node ? node.value
  : plainText(node.children) + (node.block ? '\n\n' : '')).join('');
const flattenQuotes = entries => entries.flatMap(node => node.quote ? flattenQuotes(node.children)
  : node.children ? [{ ...node, children: flattenQuotes(node.children) }] : [node]);

function compactBlocks(tree) {
  const liftDetails = entries => entries.flatMap(node => {
    if (!node.block) return [node];
    const children = liftDetails(node.children);
    return children.some(child => child.quote && (child.expandable || child.keepOpen))
      ? [...children, text('\n\n')] : [{ ...node, children }];
  });
  tree = liftDetails(tree);
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
        } else {
          // Empty bold separates adjacent underscore delimiters, including an
          // italic span nested inside an HTML underline (and vice versa).
          const join = (a, b) => a.endsWith('_') && b.startsWith('_') ? a + '**' + b : a + b;
          part = join(join(node.open, content), node.close);
        }
      }
      if (node.block && part) {
        if (result.trim()) result = result.trimEnd() + '\n\n';
        part += '\n\n';
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
