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

test('decodes entities, ignores HTML comments and scripts, and preserves literal malformed Markdown', () => {
  assert.equal(render('A &amp; B &#x1f680; &#42;literal&#42;'), 'A & B 🚀 \\*literal\\*');
  assert.equal(render('<!-- hidden template -->\n\nVisible<br>next'), 'Visible\nnext');
  assert.equal(render('<script>alert(1)</script>'), '');
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

test('compact previews fold only above the visible character or nonempty line threshold', () => {
  for (const count of [600, 601]) {
    const result = render('x'.repeat(count), { compact: true });
    assert.equal(result.startsWith('**>'), count > 600);
  }
  for (const count of [8, 9]) {
    const source = Array.from({ length: count }, (_, i) => `Line ${i}`).join('\n');
    assert.equal(render(source, { compact: true }).startsWith('**>'), count > 8);
  }
  const link = `[short](https://example.com/${'a'.repeat(800)})`;
  assert.equal(render(link, { compact: true }), render(link), 'URL markup is not visible text length');
});

test('compact previews retain links and code, flatten quotes, and keep short introductions outside details', () => {
  const source = 'Intro\n\n> **Quoted** [link](https://example.com/)\n\n' + 'x'.repeat(601) + '\n\n```js\nconst x = `value`;\nreturn x;\n```';
  const result = render(source, { compact: true });
  assert.ok(result.startsWith('**>Intro'));
  assert.ok(result.includes('>*Quoted* [link](https://example.com/)'));
  assert.ok(result.includes('>```js\nconst x = \\`value\\`;\nreturn x;\n```||'));
  assert.doesNotMatch(result, />>|\n>const|\n>return|\n>```\|\|/);
  const url = render('[link](https://example.com/?q=`value)\n\n' + 'x'.repeat(601) + '\n\nlast line', { compact: true });
  assert.ok(url.endsWith('\n>\n>last line||'), 'backticks in link targets must not open code');
  const details = '中文说明\n\n<details><summary>English</summary>\n\n' + 'x'.repeat(800) + '\n\n</details>';
  assert.equal(render(details, { compact: true }), render(details));
  assert.ok(render('<details open><summary>English</summary>' + 'x'.repeat(800) + '</details>', { compact: true }).startsWith('>*English*'));
});

test('compact truncation includes all quote markers in its budget and keeps Unicode intact', () => {
  const source = '**' + '🧑'.repeat(2000) + '**\n\n[details](https://example.com/)';
  for (const budget of [1, 15, 50, 3900]) {
    const result = render(source, { compact: true, budget });
    assert.ok(result.length <= budget);
    assert.ok(result.isWellFormed());
    assert.ok(result === '…' || result.endsWith('…||'));
  }
});

test('renders nested HTML emphasis, underline and spoilers alongside Markdown', () => {
  assert.equal(render('A <b>bold **MD**</b> <strong>strong</strong> <i>italic</i> <em>em</em> <del>old</del> <s>s</s> <strike>strike</strike>'),
    'A *bold MD* *strong* _italic_ _em_ ~old~ ~s~ ~strike~');
  assert.equal(render('<u><em>both</em></u> <em><u>inverse</u></em> <ins>new</ins>'),
    '__**_both_**__ _**__inverse__**_ __new__');
  assert.equal(render('<span class="tg-spoiler">secret</span> <tg-spoiler>hidden</tg-spoiler>'), '||secret|| ||hidden||');
  assert.equal(render('<b><code>x_y</code></b> <u>`x_y`</u>'), '*x\\_y* __x\\_y__');
  assert.equal(render('<sup>2</sup> <sub>x</sub> <span style="color: red">red</span> <custom>**content**</custom>'), '2 x red *content*');
});

test('renders HTML paragraphs, headings, containers and definition lists without splitting inline links', () => {
  assert.equal(render('<div>\n<h2>Title</h2>\n<p>Hello <a href="issues/1"><strong>link</strong></a></p><p>Next<br/>line</p></div>'),
    '*Title*\n\nHello [*link*](https://github.com/owner/repo/issues/1)\n\nNext\nline');
  assert.equal(render('<div>\n\n**bold**\n\n- One\n- Two\n\n</div>'), '*bold*\n\n• One\n• Two');
  assert.equal(render('<dl><dt>Term</dt><dd>Definition</dd></dl><hr><p>End</p>'), '*Term*\n\nDefinition\n\n────\n\nEnd');
  assert.equal(render('<p><b>One</b> <i>Two</i> <a href="https://example.com">Three</a></p>'), '*One* _Two_ [Three](https://example.com/)');
});

test('renders HTML ordered, nested and task lists, including omitted closing li tags', () => {
  assert.equal(render('<ul><li>One<li>Two<ul><li>Nested</li></ul><li>Three</ul>'), '• One\n• Two\n  • Nested\n• Three');
  assert.equal(render('<ol start="3"><li>Three</li><li value="9">Nine</li><li>Ten</li></ol>'), '3\\. Three\n9\\. Nine\n10\\. Ten');
  assert.equal(render('<ul><li><input type="checkbox" checked disabled> Done</li><li><input type="checkbox"> Pending</li></ul>'), '☑ Done\n☐ Pending');
});

test('renders HTML tables and image links while enforcing safe destinations and entity decoding', () => {
  assert.equal(render('<table><caption>Builds</caption><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>App</td><td><a href="https://example.com">OK</a></td></tr></tbody></table>'),
    '*Builds*\n*Name* \\| *Status*\nApp \\| [OK](https://example.com/)');
  assert.equal(render('<img src="https://example.com/a.png" alt="A &amp; B"> <a name="anchor">Text</a>'), '[A & B](https://example.com/a.png) Text');
  assert.equal(render('<a href="https://example.com/?a=1&amp;b=2">Read &copy; &rarr; &nbsp; &#x1f680;</a>'), '[Read © →   🚀](https://example.com/?a=1&b=2)');
  for (const target of ['javascript:alert(1)', 'java&#x73;cript:alert(1)', 'data:text/html,evil', 'https://name:password@example.com']) {
    assert.equal(render(`<a href="${target}">label</a> <img src="${target}" alt="Preview">`), 'label Preview');
  }
  assert.equal(render('<a href="https://example.com"><img src="https://example.com/x.png" alt="Preview"></a>'), '[Preview](https://example.com/)');
  assert.equal(render('&lt;b&gt;literal&lt;/b&gt; &ast;literal&ast;'), '<b\\>literal</b\\> \\*literal\\*');
});

test('preserves HTML code and shields code examples in mixed HTML and Markdown', () => {
  assert.equal(render('<pre><code class="language-js">const x = &lt;tag&gt;;\n// `code`\n</code></pre>'), '```js\nconst x = <tag>;\n// \\`code\\`\n```');
  assert.equal(render('<code>**literal** &lt;b&gt;</code> and `<b>literal</b>`'), '`**literal** <b>` and `<b>literal</b>`');
  assert.equal(render('<kbd>Ctrl</kbd> + <samp>result</samp>'), '`Ctrl` \\+ `result`');
  for (const fence of ['```', '~~~']) {
    assert.equal(render(`<div>\n${fence}html\n<b>literal</b>\n${fence}\n</div>`), '```html\n<b>literal</b>\n```');
  }
  assert.equal(render('<div>Use `<b>example</b>` then **bold**.</div>'), 'Use `<b>example</b>` then *bold*\\.');
  assert.equal(render('<div title="`quoted` > value">Text</div>'), 'Text');
  assert.equal(render('<div>Read <https://example.com> and &lt;b&gt;literal&lt;/b&gt;</div>'), 'Read [https://example\\.com](https://example.com/) and <b\\>literal</b\\>');
});

test('keeps HTML quotations and details expandable without illegal nesting', () => {
  assert.equal(render('<blockquote><p>First</p><blockquote><b>Inner</b></blockquote></blockquote>'), '>First\n>\n>*Inner*');
  const source = '<div><details><summary><b>English</b> <a href="https://example.com">docs</a></summary>\n\n- **Fix** loading\n- Improve\n\n</details></div>';
  assert.equal(render(source), '**>*English [docs](https://example.com/)*\n>• *Fix* loading\n>• Improve||');
  assert.equal(render('<blockquote expandable>Text</blockquote>'), '**>Text||');
  assert.equal(render('<b><blockquote>Text</blockquote></b>'), '*Text*');
  const open = '<div><details open><summary>English</summary>' + 'x'.repeat(800) + '</details></div>';
  assert.ok(render(open, { compact: true }).startsWith('>*English*\n>'));
  assert.ok(!render(open, { compact: true }).includes('||'));
});

test('normalizes malformed HTML, omits non-content elements and bounds deep nesting', () => {
  assert.equal(render('<b>broken <i>nest</b> tail</i>'), '*broken _nest_* tail');
  assert.equal(render('<div><script>**secret**</script><style>bad</style><p hidden>hidden</p><iframe src="https://example.com">frame</iframe><template>template</template>Visible</div>'), 'Visible');
  for (const source of ['<b>'.repeat(1500) + 'text' + '</b>'.repeat(1500), '<div>'.repeat(2000) + 'text', '<b>unclosed', '<!-- unfinished']) {
    const result = render(source, { compact: true, budget: 100 });
    assert.ok(result.length <= 100);
    assert.ok(result.isWellFormed());
  }
});

test('HTML previews collapse and truncate with balanced formatting, code and link targets', () => {
  const source = '<div><h2>Changes</h2><p><u>' + '🧑'.repeat(2000) + '</u></p><a href="https://example.com">Read more</a></div>';
  for (const budget of [1, 15, 50, 3900]) {
    const result = render(source, { compact: true, budget });
    assert.ok(result.length <= budget);
    assert.ok(result.isWellFormed());
    assert.ok(result === '…' || result.endsWith('…||'));
    assert.doesNotMatch(result, /<\/?(?:div|h2|p|u|a)[\s>]/);
  }
  assert.equal(render('<b>' + 'x'.repeat(200) + '</b>', { maxText: 5 }), '*xxxxx*…');
  for (const count of [8, 9]) {
    const paragraphs = Array.from({ length: count }, (_, i) => `<p>Line ${i}</p>`).join('');
    assert.equal(render(paragraphs, { compact: true }).startsWith('**>'), count > 8);
  }
});
