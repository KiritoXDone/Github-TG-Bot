import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';

const options = { budget: 3900, maxText: 3000, base: 'https://github.com/owner/repo/' };
const render = (source, extra) => renderMarkdown(source, { ...options, ...extra });

test('renders headings, nested emphasis, strike, links and code using Telegram syntax', () => {
  assert.equal(render('## Changes\n\n**bold _italic_** and ~~removed~~\n\n`a_b`\n\n```js\nconst a = `x`;\n```'),
    '*Changes*\n\n*bold _italic_* and ~removed~\n\n`a_b`\n\n```js\nconst a = \\`x\\`;\n```');
  assert.equal(render('***both***'), '_*both*_');
  assert.equal(render('**bold `code`**'), '*bold code*');
  assert.equal(render('![Preview](https://example.com/image.png)'), '[Preview](https://example.com/image.png)');
  assert.equal(render('[**doc**](https://example.com/a_(b))'), '[*doc*](https://example.com/a_(b\\))');
});

test('renders lists, task lists, quotes and table rows without raw GitHub delimiters', () => {
  assert.equal(render('- first\n- **second**\n\n1. one\n2. two\n\n- [x] done\n- [ ] pending'),
    '• first\n• *second*\n\n1\\. one\n2\\. two\n\n☑ done\n☐ pending');
  assert.equal(render('> **note**\n> next\n\nnormal'), '>*note*\n>next\n\nnormal');
  assert.equal(render('> outer\n>\n> > inner'), '>outer\n>\n>inner');
  assert.equal(render('| Name | Status |\n|---|---|\n| Build | **OK** |'), '*Name* \\| *Status*\nBuild \\| *OK*');
  assert.equal(render('- parent\n  - child\n- sibling'), '• parent\n  • child\n• sibling');
});

test('decodes entities, ignores HTML comments, and safely preserves unsupported markup', () => {
  assert.equal(render('A &amp; B &#x1f680; &#42;literal&#42;'), 'A & B 🚀 \\*literal\\*');
  assert.equal(render('<!-- hidden template -->\n\nVisible<br>next'), 'Visible\nnext');
  assert.equal(render('<script>alert(1)</script>'), '<script\\>alert\\(1\\)</script\\>');
  assert.equal(render('unclosed **bold [link]('), 'unclosed \\*\\*bold \\[link\\]\\(');
});

test('keeps safe absolute and relative links, strips unsafe destinations, and resolves references', () => {
  assert.equal(render('[doc](issues/1) [guide][g]\n\n[g]: https://example.com/guide'),
    '[doc](https://github.com/owner/repo/issues/1) [guide](https://example.com/guide)');
  for (const target of ['javascript:alert%281%29', 'data:text/html,evil', 'tg://user?id=123', 'https://name:password@example.com/x']) {
    assert.equal(render(`[label](${target})`), 'label');
  }
  assert.equal(render('[query](https://example.com/?a=1&amp;b=2)'), '[query](https://example.com/?a=1&b=2)');
});

test('truncates within formatting while closing code, bold and link entities', () => {
  const text = '🧑'.repeat(3000);
  for (const source of [`**${text}**`, `[${text}](https://example.com/path)`, '```js\n' + text + '\n```', `> **${text}**`]) {
    for (const budget of [1, 10, 40, 100, 3900]) {
      const result = render(source, { budget });
      assert.ok(result.length <= budget, `${budget}: ${result.length}`);
      assert.ok(result.isWellFormed());
      assert.ok(result.endsWith('…'));
      if (result.includes('](')) assert.match(result, /\]\(https:\/\/example.com\/path\)…$/);
      if (result.startsWith('```')) assert.ok(result.endsWith('\n```…'));
      if (result.startsWith('*')) assert.ok(result.endsWith('*…'));
    }
  }
  assert.equal(render('**' + 'x'.repeat(50) + '**', { maxText: 5 }), '*xxxxx*…');
});

test('keeps bounded work for oversized, punctuation-heavy and malformed bodies', () => {
  for (const source of ['#\n'.repeat(10000), '*'.repeat(20000), '[x]('.repeat(5000), '> '.repeat(1000) + 'nested', '\ud800']) {
    const result = render(source);
    assert.ok(result.length <= 3900);
    assert.ok(result.isWellFormed());
  }
});

test('renders GitHub details as a Telegram expandable quote with a summary heading', () => {
  assert.equal(render('<details>\n<summary>English</summary>• Improve picker.\n• Fix loading.\n\n</details>'),
    '**>*English*\n>• Improve picker\\.\n>• Fix loading\\.||');
  assert.equal(render('中文说明\n\n<details>\n<summary>**English**</summary>\n\n- **Fix** loading\n- Improve navigation\n\n</details>\n\nAfter'),
    '中文说明\n\n**>*English*\n>• *Fix* loading\n>• Improve navigation||\n\nAfter');
  assert.equal(render('<details open><summary>English</summary>Shown</details>'), '>*English*\n>Shown');
  assert.equal(render('<details>No summary</details>'), '**>*Details*\n>No summary||');
  assert.equal(render('<details><summary><b>English &amp; notes</b></summary>Body</details>'), '**>*English & notes*\n>Body||');
});

test('handles adjacent and nested details without nesting Telegram quotes or consuming surrounding text', () => {
  assert.equal(render('<details><summary>One</summary>First</details>\n<details><summary>Two</summary>Second</details>'),
    '**>*One*\n>First||\n\n**>*Two*\n>Second||');
  assert.equal(render('<details><summary>Outer</summary>Before\n\n<details><summary>Inner</summary>Inside</details>\n\nAfter</details>'),
    '**>*Outer*\n>Before\n>\n>*Inner*\n>Inside\n>\n>After||');
  assert.equal(render('> <details><summary>English</summary>\n> Body\n> </details>'), '>*English*\n>Body');
  assert.ok(render('<details><summary>English</summary>`</details>`\n\n<!-- </details> -->\n\nEnd</details>').endsWith('>End||'));
  assert.equal(render('```html\n<details><summary>Example</summary></details>\n```'),
    '```html\n<details><summary>Example</summary></details>\n```');
});

test('keeps expandable details valid when closing tags are missing or long content is truncated', () => {
  assert.equal(render('<details><summary>English</summary>Unclosed **bold**'), '**>*English*\n>Unclosed *bold*||');
  for (const budget of [1, 15, 50, 3900]) {
    const result = render('<details><summary>English</summary>\n\n' + '🧑'.repeat(12000) + '</details>', { budget });
    assert.ok(result.length <= budget);
    assert.ok(result.isWellFormed());
    assert.ok(result === '…' || result.endsWith('…||'));
    assert.doesNotMatch(result, /<\/?details|<\/?summary|\|\|…/);
  }
});
